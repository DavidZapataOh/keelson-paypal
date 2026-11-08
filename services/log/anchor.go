package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"filippo.io/torchwood"
	"filippo.io/torchwood/tesserax"
	"github.com/DavidZapataOh/keelson-paypal/internal/alibilog"
	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind/v2"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/rpc"
	"golang.org/x/mod/sumdb/tlog"
)

const (
	// anchorTick is how often each origin's published size is compared with
	// its latest anchor.
	anchorTick = 10 * time.Second
	// anchorEvery is how long a grown log waits for its next anchor, unless
	// anchorLeaves leaves were added first.
	anchorEvery  = time.Hour
	anchorLeaves = 1000
	// anchorTimeout bounds one anchor, from the legs' signatures to the receipt.
	anchorTimeout = 2 * time.Minute
	// maxNote is the longest signed note CheckpointAnchor accepts.
	maxNote = 8192
)

//go:embed abi/CheckpointAnchor.json
var checkpointAnchorABI []byte

var anchorABI = func() abi.ABI {
	a, err := abi.JSON(bytes.NewReader(checkpointAnchorABI))
	if err != nil {
		panic(err)
	}
	return a
}()

var (
	errTEEUnavailable = errors.New("tee_unavailable")
	errChain          = errors.New("chain")
	// errFork is a published checkpoint that does not extend, or contradicts,
	// what is anchored: the log was rewritten or rolled back.
	errFork = errors.New("fork")
)

// chainError wraps an RPC failure without the RPC URL, which carries the
// provider's API key.
func chainError(op string, err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return fmt.Errorf("%w: %s: %v", errChain, op, err)
}

// signerRegistry is the API's admitted TEE signers, as admission reads them.
type signerRegistry interface {
	Active(ctx context.Context, teeKind int, address [20]byte, at time.Time) (string, bool, error)
}

// anchorTarget is the CheckpointAnchor one origin anchors to.
type anchorTarget struct {
	origin   *origin
	hash     [32]byte
	chainID  uint64
	client   *ethclient.Client
	contract *bind.BoundContract
	// anchored is the latest anchored size read from the chain.
	anchored atomic.Uint64
	// last is the latest anchor this process sent.
	last *anchorResult
}

// anchorResult is the answer to a request to anchor an origin now.
type anchorResult struct {
	Size  string  `json:"size"`
	Root  string  `json:"root"`
	Tx    *string `json:"tx"`
	Fresh bool    `json:"fresh"`
}

// anchorer anchors the witnessed checkpoints of each origin with a chain on
// that chain's CheckpointAnchor, signed by both TEE legs. The chain is its only
// state.
type anchorer struct {
	targets           map[string]*anchorTarget
	legs              [2]*legClient
	key               *ecdsa.PrivateKey
	from              common.Address
	verifyingContract [20]byte
	reg               signerRegistry
	log               *slog.Logger
	clock             func() time.Time
	// mu keeps one anchor in flight, which also keeps the submitter's nonces
	// in order across origins.
	mu sync.Mutex
	// pending is the nonce of a sent anchor whose receipt was not seen;
	// nothing else is sent until the account's mined nonce passes it.
	pending *uint64
}

func newAnchorer(cfg *anchorConfig, verifyingContract [20]byte, origins []*origin, reg signerRegistry, log *slog.Logger) (*anchorer, error) {
	a := &anchorer{
		targets:           map[string]*anchorTarget{},
		legs:              [2]*legClient{newLegClient(cfg.TEEA, cfg.Token), newLegClient(cfg.TEEB, cfg.Token)},
		key:               cfg.Key,
		from:              crypto.PubkeyToAddress(cfg.Key.PublicKey),
		verifyingContract: verifyingContract,
		reg:               reg,
		log:               log,
		clock:             time.Now,
	}
	for _, o := range origins {
		rpcURL, ok := cfg.RPC[o.chainID]
		if !ok {
			continue
		}
		client, err := ethclient.Dial(rpcURL)
		if err != nil {
			return nil, err
		}
		a.targets[o.name] = &anchorTarget{
			origin:   o,
			hash:     crypto.Keccak256Hash([]byte(o.name)),
			chainID:  o.chainID,
			client:   client,
			contract: bind.NewBoundContract(cfg.Address, anchorABI, client, client, client),
		}
	}
	return a, nil
}

// due reports whether an origin whose published checkpoint has published
// leaves and whose latest anchor has onchain leaves, made at lastAnchorAt,
// needs an anchor at now.
func due(published, onchain uint64, lastAnchorAt, now time.Time) bool {
	return published > onchain && (now.Sub(lastAnchorAt) >= anchorEvery || published-onchain >= anchorLeaves)
}

// latest reads the origin's latest anchor.
func (t *anchorTarget) latest(ctx context.Context) (uint64, [32]byte, time.Time, error) {
	var out []any
	if err := t.contract.Call(&bind.CallOpts{Context: ctx}, &out, "latest", t.hash); err != nil {
		return 0, [32]byte{}, time.Time{}, chainError("latest", err)
	}
	size, root, at := out[0].(uint64), out[1].([32]byte), out[2].(*big.Int)
	t.anchored.Store(size)
	return size, root, time.Unix(at.Int64(), 0), nil
}

// run checks every origin each anchorTick and anchors those that are due.
func (a *anchorer) run(ctx context.Context) {
	t := time.NewTicker(anchorTick)
	defer t.Stop()
	for {
		a.tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (a *anchorer) tick(ctx context.Context) {
	for _, t := range a.targets {
		n, err := t.origin.size(ctx)
		if err != nil {
			a.log.Error("anchor", "origin", t.origin.name, "err", err)
			continue
		}
		size, _, at, err := t.latest(ctx)
		if err != nil {
			a.log.Error("anchor", "origin", t.origin.name, "err", err)
			continue
		}
		if !due(uint64(n), size, at, a.clock()) {
			continue
		}
		if _, err := a.now(ctx, t); errors.Is(err, errFork) {
			a.log.Error("anchor: the log contradicts its anchors", "origin", t.origin.name, "err", err)
		} else if err != nil {
			a.log.Error("anchor", "origin", t.origin.name, "err", err)
		}
	}
}

func hex0x(b []byte) string { return "0x" + hex.EncodeToString(b) }

// now anchors the origin's published checkpoint unless it is already
// anchored, in which case it answers the latest anchor.
func (a *anchorer) now(ctx context.Context, t *anchorTarget) (*anchorResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, anchorTimeout)
	defer cancel()
	start := time.Now()

	signed, err := t.origin.reader.ReadCheckpoint(ctx)
	if err != nil {
		return nil, err
	}
	c, err := torchwood.ParseCheckpoint(checkpointBody(signed))
	if err != nil {
		return nil, err
	}
	if a.pending != nil {
		mined, err := t.client.NonceAt(ctx, a.from, nil)
		if err != nil {
			return nil, chainError("nonce", err)
		}
		if mined <= *a.pending {
			return nil, fmt.Errorf("%w: the anchor with nonce %d is still pending", errChain, *a.pending)
		}
		a.pending = nil
	}
	size, root, _, err := t.latest(ctx)
	if err != nil {
		return nil, err
	}
	if uint64(c.N) <= size {
		if err := t.checkAnchored(ctx, uint64(c.N), c.Hash, size, root); err != nil {
			return nil, err
		}
		return t.anchoredResult(size, root), nil
	}
	if len(signed) > maxNote {
		return nil, fmt.Errorf("the signed note has %d bytes, over %d", len(signed), maxNote)
	}

	sigs, err := a.signatures(ctx, t, signed, c)
	if err != nil {
		return nil, err
	}
	proof := [][32]byte{}
	if size > 0 {
		p, err := tlog.ProveTree(c.N, int64(size), torchwood.TileHashReaderWithContext(ctx, c.Tree, tesserax.NewTileReader(t.origin.reader)))
		if err != nil {
			return nil, fmt.Errorf("consistency proof: %w", err)
		}
		for _, h := range p {
			proof = append(proof, h)
		}
	}
	data, err := anchorABI.Pack("anchor", t.hash, uint64(c.N), [32]byte(c.Hash), proof, sigs, signed)
	if err != nil {
		return nil, err
	}
	to := t.contract.Address()
	gas, err := t.client.EstimateGas(ctx, ethereum.CallMsg{From: a.from, To: &to, Data: data})
	switch {
	case reverted(err, "AlreadyAnchored"):
		size, root, _, err := t.latest(ctx)
		if err != nil {
			return nil, err
		}
		return t.anchoredResult(size, root), nil
	case reverted(err, "InconsistentCheckpoint"):
		return nil, fmt.Errorf("%w: size %d does not extend the anchor at %d", errFork, c.N, size)
	case err != nil:
		return nil, chainError("estimate", err)
	}
	// The transaction outlives the request that asked for it.
	sendCtx, cancelSend := context.WithTimeout(context.WithoutCancel(ctx), anchorTimeout)
	defer cancelSend()
	opts := bind.NewKeyedTransactor(a.key, new(big.Int).SetUint64(t.chainID))
	opts.Context = sendCtx
	opts.GasLimit = gas * 6 / 5
	tx, err := t.contract.RawTransact(opts, data)
	if err != nil {
		return nil, chainError("send", err)
	}
	h := tx.Hash()
	nonce := tx.Nonce()
	a.pending = &nonce
	receipt, err := bind.WaitMined(sendCtx, t.client, h)
	if err != nil {
		return nil, chainError("receipt of "+h.Hex(), err)
	}
	a.pending = nil
	if receipt.Status != 1 {
		return nil, fmt.Errorf("%w: %s reverted", errChain, h)
	}
	t.anchored.Store(uint64(c.N))
	hash := tx.Hash().Hex()
	t.last = &anchorResult{Size: strconv.FormatInt(c.N, 10), Root: hex0x(c.Hash[:]), Tx: &hash, Fresh: true}
	a.log.Info("anchor", "origin", t.origin.name, "size", c.N, "tx", hash, "gasUsed", receipt.GasUsed, "ms", time.Since(start).Milliseconds())
	return t.last, nil
}

// checkAnchored fails with errFork when the published checkpoint of size n
// and root contradicts the anchors: another root anchored at n, or the latest
// anchor at n itself with another root.
func (t *anchorTarget) checkAnchored(ctx context.Context, n uint64, root [32]byte, latest uint64, latestRoot [32]byte) error {
	anchored := latestRoot
	if n != latest {
		var out []any
		if err := t.contract.Call(&bind.CallOpts{Context: ctx}, &out, "rootAt", t.hash, n); err != nil {
			return chainError("rootAt", err)
		}
		anchored = out[0].([32]byte)
	}
	if anchored != ([32]byte{}) && anchored != root {
		return fmt.Errorf("%w: the published root at %d is not the anchored one", errFork, n)
	}
	return nil
}

// anchoredResult is the latest anchor, with its transaction when this process
// sent it.
func (t *anchorTarget) anchoredResult(size uint64, root [32]byte) *anchorResult {
	r := &anchorResult{Size: strconv.FormatUint(size, 10), Root: hex0x(root[:])}
	if t.last != nil && t.last.Size == r.Size {
		r.Tx = t.last.Tx
	}
	return r
}

// signatures asks both legs to sign the checkpoint's EIP-712 Checkpoint and
// returns tdx ‖ nitro once each signature recovers, over the digest computed
// here, to a signer the API admitted for its leg.
func (a *anchorer) signatures(ctx context.Context, t *anchorTarget, signed []byte, c torchwood.Checkpoint) ([]byte, error) {
	digest := alibilog.CheckpointDigest(t.hash, uint64(c.N), c.Hash, t.chainID, a.verifyingContract)
	var sigs [2][]byte
	var errs [2]error
	var wg sync.WaitGroup
	for i, leg := range a.legs {
		wg.Go(func() {
			sigs[i], errs[i] = a.signature(ctx, leg, []int{teeTDX, teeNitro}[i], digest, signed, t.chainID)
		})
	}
	wg.Wait()
	if err := errors.Join(errs[:]...); err != nil {
		return nil, fmt.Errorf("%w: %v", errTEEUnavailable, err)
	}
	return append(sigs[0], sigs[1]...), nil
}

func (a *anchorer) signature(ctx context.Context, leg *legClient, kind int, digest [32]byte, signed []byte, chainID uint64) ([]byte, error) {
	r, err := leg.checkpoint(ctx, signed, chainID)
	if err != nil {
		return nil, fmt.Errorf("tee %d: %w", kind, err)
	}
	raw, err := hex.DecodeString(strings.TrimPrefix(r.Signature, "0x"))
	if err != nil || len(raw) != 65 {
		return nil, fmt.Errorf("tee %d: malformed signature", kind)
	}
	signer, err := alibilog.Recover(digest, [65]byte(raw))
	if err != nil {
		return nil, fmt.Errorf("tee %d: %w", kind, err)
	}
	_, ok, err := a.reg.Active(ctx, kind, signer, time.Now())
	if err != nil {
		return nil, fmt.Errorf("tee %d: registry: %w", kind, err)
	}
	if !ok {
		return nil, fmt.Errorf("tee %d: %s is not an admitted signer", kind, hex0x(signer[:]))
	}
	return raw, nil
}

// reverted reports whether err is a revert with the CheckpointAnchor error
// name.
func reverted(err error, name string) bool {
	var de rpc.DataError
	if err == nil || !errors.As(err, &de) {
		return false
	}
	data, ok := de.ErrorData().(string)
	if !ok {
		return false
	}
	id := anchorABI.Errors[name].ID
	return strings.HasPrefix(data, hex0x(id[:4]))
}
