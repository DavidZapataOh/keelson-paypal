package main

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/rpc"
)

// chainTrust is the chain an origin anchors to and the contracts the monitor
// reads there, pinned in its binary as the policies are.
type chainTrust struct {
	ChainID          uint64
	Name             string
	RPC              []string
	CheckpointAnchor common.Address
	VerdictVerifier  common.Address
	// FromBlock is the block VerdictVerifier was created in, and FromTime its
	// timestamp: no signer was registered before it.
	FromBlock uint64
	FromTime  time.Time
	// CountersignWindow is how long a countersign stays valid after its
	// issuedAt: the registry's dispute window.
	CountersignWindow time.Duration
}

// arbitrumSepolia is where the sandbox origin anchors, as in
// contracts/deployments/421614.json.
func arbitrumSepolia(getenv func(string) string) *chainTrust {
	var rpcs []string
	if u := getenv("ARBITRUM_SEPOLIA_RPC_URL"); u != "" {
		rpcs = append(rpcs, u)
	}
	return &chainTrust{
		ChainID:          421614,
		Name:             "Arbitrum Sepolia",
		RPC:              append(rpcs, "https://sepolia-rollup.arbitrum.io/rpc"),
		CheckpointAnchor: common.HexToAddress("0x049621749722D0660d5026456F25192fBD9A57ab"),
		VerdictVerifier:  common.HexToAddress("0xe16E8767EC1DA59Ef0D9Bc7851637E4D22352d96"),
		FromBlock:        327178923,
		FromTime:         time.Unix(1794122110, 0).UTC(),

		CountersignWindow: 600 * time.Second,
	}
}

// arbitrumOne is where the live origin will anchor; contracts/deployments/
// 42161.json holds no contracts yet.
var arbitrumOne = &chainTrust{ChainID: 42161, Name: "Arbitrum One"}

// maxChainResponseBytes bounds an RPC response; a larger eth_getLogs answer
// is split into smaller block ranges.
const maxChainResponseBytes = 4 << 20

// anchorABI is the part of CheckpointAnchor the monitor reads.
const anchorABI = `[{"type":"function","name":"latest","stateMutability":"view","inputs":[{"name":"origin","type":"bytes32"}],"outputs":[{"name":"size","type":"uint64"},{"name":"root","type":"bytes32"},{"name":"anchoredAt","type":"uint40"}]},
{"type":"function","name":"rootAt","stateMutability":"view","inputs":[{"name":"origin","type":"bytes32"},{"name":"size","type":"uint64"}],"outputs":[{"name":"root","type":"bytes32"}]}]`

// verifierABI holds the VerdictVerifier events the signer index is built from.
const verifierABI = `[{"type":"event","name":"SignerRegistered","inputs":[{"name":"signer","type":"address","indexed":true},{"name":"teeKind","type":"uint8"},{"name":"measurement","type":"bytes32"},{"name":"registeredAt","type":"uint40"},{"name":"expiresAt","type":"uint40"}]},
{"type":"event","name":"SignerRevoked","inputs":[{"name":"signer","type":"address","indexed":true},{"name":"revokedAt","type":"uint40"}]},
{"type":"event","name":"SignerEquivocated","inputs":[{"name":"signer","type":"address","indexed":true},{"name":"digestA","type":"bytes32"},{"name":"digestB","type":"bytes32"}]}]`

var (
	anchorContract   = mustABI(anchorABI)
	verifierContract = mustABI(verifierABI)
)

func mustABI(s string) abi.ABI {
	a, err := abi.JSON(strings.NewReader(s))
	if err != nil {
		panic(err)
	}
	return a
}

// chainReader reads one chain through its RPC endpoints, in order.
type chainReader struct {
	t       *chainTrust
	clients []*ethclient.Client
}

func newChainReader(ctx context.Context, t *chainTrust) (*chainReader, error) {
	hc := &http.Client{Timeout: 15 * time.Second, Transport: limitedTransport{http.DefaultTransport, maxChainResponseBytes}}
	c := &chainReader{t: t}
	for _, u := range t.RPC {
		rc, err := rpc.DialOptions(ctx, u, rpc.WithHTTPClient(hc))
		if err != nil {
			return nil, err
		}
		c.clients = append(c.clients, ethclient.NewClient(rc))
	}
	if len(c.clients) == 0 {
		return nil, errors.New("no RPC endpoint")
	}
	return c, nil
}

// do runs call on each endpoint until one answers.
func (c *chainReader) do(call func(*ethclient.Client) error) error {
	var errs []error
	for _, cl := range c.clients {
		err := call(cl)
		if err == nil {
			return nil
		}
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

func (c *chainReader) close() {
	for _, cl := range c.clients {
		cl.Close()
	}
}

// latestAnchor returns the origin's latest anchored checkpoint; size 0 means
// none.
func (c *chainReader) latestAnchor(ctx context.Context, origin string) (uint64, [32]byte, time.Time, error) {
	data, err := anchorContract.Pack("latest", crypto.Keccak256Hash([]byte(origin)))
	if err != nil {
		return 0, [32]byte{}, time.Time{}, err
	}
	var out []byte
	err = c.do(func(cl *ethclient.Client) error {
		var err error
		out, err = cl.CallContract(ctx, ethereum.CallMsg{To: &c.t.CheckpointAnchor, Data: data}, nil)
		return err
	})
	if err != nil {
		return 0, [32]byte{}, time.Time{}, err
	}
	v, err := anchorContract.Unpack("latest", out)
	if err != nil || len(v) != 3 {
		return 0, [32]byte{}, time.Time{}, fmt.Errorf("latest: %w", err)
	}
	return v[0].(uint64), v[1].([32]byte), time.Unix(v[2].(*big.Int).Int64(), 0).UTC(), nil
}

// maxLogRange is the widest block range asked for at once; a range an
// endpoint refuses is halved down to minLogRange.
const (
	maxLogRange = 1 << 22
	minLogRange = 10_000
)

// signerLogs returns the signer events in [from, head] and head, the latest
// block when the call started.
func (c *chainReader) signerLogs(ctx context.Context, from uint64) ([]types.Log, uint64, error) {
	var head uint64
	if err := c.do(func(cl *ethclient.Client) error {
		var err error
		head, err = cl.BlockNumber(ctx)
		return err
	}); err != nil {
		return nil, 0, err
	}
	topics := []common.Hash{
		verifierContract.Events["SignerRegistered"].ID,
		verifierContract.Events["SignerRevoked"].ID,
		verifierContract.Events["SignerEquivocated"].ID,
	}
	var logs []types.Log
	span := uint64(maxLogRange)
	for from <= head {
		to := min(head, from+span-1)
		var got []types.Log
		err := c.do(func(cl *ethclient.Client) error {
			var err error
			got, err = cl.FilterLogs(ctx, ethereum.FilterQuery{
				FromBlock: new(big.Int).SetUint64(from),
				ToBlock:   new(big.Int).SetUint64(to),
				Addresses: []common.Address{c.t.VerdictVerifier},
				Topics:    [][]common.Hash{topics},
			})
			return err
		})
		if err != nil {
			if span > minLogRange && ctx.Err() == nil {
				span = max(span/2, minLogRange)
				continue
			}
			return nil, 0, err
		}
		logs = append(logs, got...)
		from = to + 1
	}
	return logs, head, nil
}
