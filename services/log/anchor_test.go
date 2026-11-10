package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"filippo.io/torchwood"
	"github.com/DavidZapataOh/keelson-paypal/internal/conformance"
	"github.com/ethereum/go-ethereum/accounts/abi/bind/v2"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/rpc"
	"github.com/transparency-dev/tessera"
	"golang.org/x/mod/sumdb/note"
)

func TestAnchorIsDueHourlyOrEveryThousandLeaves(t *testing.T) {
	at := time.Unix(1_800_000_000, 0)
	for _, c := range []struct {
		published, onchain uint64
		since              time.Duration
		want               bool
	}{
		{0, 0, 2 * time.Hour, false},
		{10, 10, 2 * time.Hour, false},
		{11, 10, 59 * time.Minute, false},
		{11, 10, time.Hour, true},
		{1009, 10, time.Minute, false},
		{1010, 10, time.Minute, true},
		{5, 0, 0, false},
	} {
		if got := due(c.published, c.onchain, at, at.Add(c.since)); got != c.want {
			t.Errorf("due(%d, %d, +%s) = %v", c.published, c.onchain, c.since, got)
		}
	}
	if !due(1, 0, time.Unix(0, 0), at) {
		t.Error("the first anchor of an origin waits for nothing")
	}
}

// The VerdictVerifier on Arbitrum Sepolia and its storage layout
// (forge inspect VerdictVerifier storageLayout).
const (
	verdictVerifier     = "0xe16E8767EC1DA59Ef0D9Bc7851637E4D22352d96"
	measurementIDsSlot  = 4
	allowedSlot         = 5
	signersSlot         = 7
	signerTTL           = 72 * 3600
	conformancePolicyFn = "policy/conformance-2026-1.policy"
)

// anvilFork is anvil forking Arbitrum Sepolia: the chain id stays 421614, so
// the live legs' signatures verify against the VerdictVerifier on the fork.
type anvilFork struct {
	url    string
	client *ethclient.Client
	rpc    *rpc.Client
}

func startAnvil(t *testing.T, forkURL string) *anvilFork {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	cmd := exec.Command("anvil", "--fork-url", forkURL, "--port", fmt.Sprint(port), "--silent")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	deadline := time.Now().Add(30 * time.Second)
	for {
		c, err := rpc.Dial(url)
		if err == nil {
			var id hexutil.Uint64
			if err = c.Call(&id, "eth_chainId"); err == nil {
				if id != 421614 {
					t.Fatalf("fork chain id %d", id)
				}
				return &anvilFork{url: url, client: ethclient.NewClient(c), rpc: c}
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("anvil did not start: %v", err)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// fundedKey is a fresh key with 1 ETH on the fork.
func (f *anvilFork) fundedKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	if err := f.rpc.Call(nil, "anvil_setBalance", crypto.PubkeyToAddress(key.PublicKey), hexutil.EncodeBig(big.NewInt(1e18))); err != nil {
		t.Fatal(err)
	}
	return key
}

func (f *anvilFork) storage(t *testing.T, addr common.Address, slot common.Hash) common.Hash {
	t.Helper()
	v, err := f.client.StorageAt(context.Background(), addr, slot, nil)
	if err != nil {
		t.Fatal(err)
	}
	return common.BytesToHash(v)
}

func (f *anvilFork) setStorage(t *testing.T, addr common.Address, slot, value common.Hash) {
	t.Helper()
	if err := f.rpc.Call(nil, "anvil_setStorageAt", addr, slot, value); err != nil {
		t.Fatal(err)
	}
}

func mappingSlot(key common.Hash, slot int64) common.Hash {
	return crypto.Keccak256Hash(key[:], common.BigToHash(big.NewInt(slot)).Bytes())
}

// registerOnFork writes the leg's signer record into the VerdictVerifier on the
// fork, as a registration through its attestation path would on the live
// chain, under the measurement measurements.json allows.
func (f *anvilFork) registerOnFork(t *testing.T, signer common.Address, kind int, measurement common.Hash) {
	t.Helper()
	vv := common.HexToAddress(verdictVerifier)
	id := f.storage(t, vv, mappingSlot(measurement, measurementIDsSlot)).Big()
	if id.Sign() == 0 || f.storage(t, vv, mappingSlot(common.BigToHash(id), allowedSlot)).Big().Sign() == 0 {
		t.Fatalf("measurement %s is not allowed on Arbitrum Sepolia", measurement)
	}
	head, err := f.client.HeaderByNumber(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	now := new(big.Int).SetUint64(head.Time)
	packed := new(big.Int).SetInt64(int64(kind))
	packed.Or(packed, new(big.Int).Lsh(now, 8))
	packed.Or(packed, new(big.Int).Lsh(new(big.Int).Add(now, big.NewInt(signerTTL)), 48))
	packed.Or(packed, new(big.Int).Lsh(id, 128))
	slot := mappingSlot(common.BytesToHash(signer[:]), signersSlot)
	f.setStorage(t, vv, slot, common.BigToHash(packed))
	f.setStorage(t, vv, common.BigToHash(new(big.Int).Add(slot.Big(), big.NewInt(1))), measurement)
}

// deployAnchor deploys a fresh CheckpointAnchor over the VerdictVerifier from
// the Foundry build output, so the live contract's anchors do not interfere.
func (f *anvilFork) deployAnchor(t *testing.T) common.Address {
	t.Helper()
	raw, err := os.ReadFile("../../contracts/out/CheckpointAnchor.sol/CheckpointAnchor.json")
	if err != nil {
		t.Fatalf("%v (run forge build in contracts/)", err)
	}
	var artifact struct {
		Bytecode struct {
			Object string `json:"object"`
		} `json:"bytecode"`
	}
	if err := json.Unmarshal(raw, &artifact); err != nil {
		t.Fatal(err)
	}
	code := common.FromHex(artifact.Bytecode.Object)
	args, err := anchorABI.Pack("", common.HexToAddress(verdictVerifier))
	if err != nil {
		t.Fatal(err)
	}
	opts := bind.NewKeyedTransactor(f.fundedKey(t), big.NewInt(421614))
	addr, tx, err := bind.DeployContract(opts, code, f.client, args)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := bind.WaitDeployed(context.Background(), f.client, tx.Hash()); err != nil {
		t.Fatal(err)
	}
	return addr
}

type legHealth struct {
	Signer string `json:"signer"`
}

func legSigner(t *testing.T, url string) common.Address {
	t.Helper()
	resp, err := http.Get(strings.TrimSuffix(url, "/") + "/v1/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var h legHealth
	if err := json.NewDecoder(resp.Body).Decode(&h); err != nil {
		t.Fatal(err)
	}
	return common.HexToAddress(h.Signer)
}

func measurementIDs(t *testing.T) (tdx, nitro string) {
	t.Helper()
	raw, err := os.ReadFile("../../engine/tee/measurements.json")
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		TDX   struct{ ID string } `json:"tdx"`
		Nitro struct{ ID string } `json:"nitro"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m.TDX.ID, m.Nitro.ID
}

func idHash(id string) common.Hash {
	_, h, _ := strings.Cut(id, ":")
	return common.HexToHash(h)
}

func liveEnv(t *testing.T, names ...string) map[string]string {
	t.Helper()
	if os.Getenv("KEELSON_LIVE") != "1" {
		t.Skip("KEELSON_LIVE=1 runs against the live legs and a fork of Arbitrum Sepolia")
	}
	env := map[string]string{}
	for _, n := range names {
		if env[n] = os.Getenv(n); env[n] == "" {
			t.Fatalf("%s is required", n)
		}
	}
	return env
}

// anchorRig is a conformance-origin log on a temp dir, anchored on a fork by
// an anchorer with a clock the test moves.
type anchorRig struct {
	o       *origin
	a       *anchorer
	target  *anchorTarget
	fork    *anvilFork
	private *httptest.Server
	clock   atomic.Int64
	from    common.Address
}

func newAnchorRig(t *testing.T, legB string) *anchorRig {
	t.Helper()
	env := liveEnv(t, "ARBITRUM_SEPOLIA_RPC_URL", "TEE_A_URL", "TEE_B_URL", "KEELSON_TEE_TOKEN", "LOG_SIGNER_KEY_CONFORMANCE")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	fork := startAnvil(t, env["ARBITRUM_SEPOLIA_RPC_URL"])
	anchorAddr := fork.deployAnchor(t)

	tdxID, nitroID := measurementIDs(t)
	tdx, nitro := legSigner(t, env["TEE_A_URL"]), legSigner(t, env["TEE_B_URL"])
	fork.registerOnFork(t, tdx, teeTDX, idHash(tdxID))
	fork.registerOnFork(t, nitro, teeNitro, idHash(nitroID))
	db, _ := testDB(t)
	activate(t, db, teeTDX, tdx.Hex(), tdxID)
	activate(t, db, teeNitro, nitro.Hex(), nitroID)

	signer, err := note.NewSigner(env["LOG_SIGNER_KEY_CONFORMANCE"])
	if err != nil {
		t.Fatal(err)
	}
	policy, err := os.ReadFile(conformancePolicyFn)
	if err != nil {
		t.Fatal(err)
	}
	logLine, _, _ := strings.Cut(string(policy[strings.Index(string(policy), "\nlog ")+1:]), "\n")
	spec := originSpec{Name: conformance.Origin, ChainID: 421614}
	vc := common.HexToAddress(verdictVerifier)
	o, err := openOrigin(ctx, spec, t.TempDir(), vc, []note.Signer{signer}, []byte(logLine+"\nquorum none\n"))
	if err != nil {
		t.Fatal(err)
	}
	key := fork.fundedKey(t)
	cfg := &anchorConfig{
		Address: anchorAddr,
		RPC:     map[uint64][]string{421614: {fork.url}},
		Key:     key,
		TEEA:    env["TEE_A_URL"],
		TEEB:    cmpOr(legB, env["TEE_B_URL"]),
		Token:   env["KEELSON_TEE_TOKEN"],
	}
	r := &anchorRig{o: o, fork: fork, from: crypto.PubkeyToAddress(key.PublicKey)}
	r.clock.Store(time.Now().UnixNano())
	r.a, err = newAnchorer(cfg, vc, []*origin{o}, registry{db}, slog.New(slog.NewTextHandler(os.Stderr, nil)))
	if err != nil {
		t.Fatal(err)
	}
	r.a.clock = func() time.Time { return time.Unix(0, r.clock.Load()) }
	r.target = r.a.targets[o.name]
	s := &server{origins: []*origin{o}, registry: registry{db}, tokenHash: testTokenHash(), log: slog.New(slog.DiscardHandler), anchor: r.a}
	r.private = httptest.NewServer(s.private())
	t.Cleanup(r.private.Close)
	return r
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func testTokenHash() [32]byte {
	return sha256.Sum256([]byte(testToken))
}

func (r *anchorRig) advance(d time.Duration) { r.clock.Add(int64(d)) }

func (r *anchorRig) nonce(t *testing.T) uint64 {
	t.Helper()
	n, err := r.fork.client.NonceAt(context.Background(), r.from, nil)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// appendLeaves adds n entries and waits for a published checkpoint covering them.
func (r *anchorRig) appendLeaves(t *testing.T, n int) int64 {
	t.Helper()
	ctx := context.Background()
	var last tessera.IndexFuture
	for range n {
		last = r.o.add(ctx, tessera.NewEntry(randBytes(32)))
	}
	idx, _, err := r.o.awaiter.Await(ctx, last)
	if err != nil {
		t.Fatal(err)
	}
	return int64(idx.Index) + 1
}

func (r *anchorRig) post(t *testing.T) (int, anchorResult, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, r.private.URL+"/"+r.o.path+"/anchor", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var res anchorResult
	_ = json.Unmarshal(raw, &res)
	return resp.StatusCode, res, string(raw)
}

func (r *anchorRig) rootAt(t *testing.T, size uint64) [32]byte {
	t.Helper()
	var out []any
	if err := r.target.contract.Call(&bind.CallOpts{}, &out, "rootAt", r.target.hash, size); err != nil {
		t.Fatal(err)
	}
	return out[0].([32]byte)
}

func (r *anchorRig) logRoot(t *testing.T) (int64, string) {
	t.Helper()
	signed, err := r.o.reader.ReadCheckpoint(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	c, err := torchwood.ParseCheckpoint(checkpointBody(signed))
	if err != nil {
		t.Fatal(err)
	}
	return c.N, "0x" + hex.EncodeToString(c.Hash[:])
}

func TestAnchorSchedule(t *testing.T) {
	r := newAnchorRig(t, "")
	ctx := context.Background()

	start := r.nonce(t)
	r.a.tick(ctx)
	r.a.tick(ctx)
	if r.nonce(t) != start {
		t.Fatal("an empty log was anchored")
	}

	// The first anchor of an origin is due at once.
	r.appendLeaves(t, 1)
	r.a.tick(ctx)
	if r.nonce(t) != start+1 || r.target.anchored.Load() != 1 {
		t.Fatalf("first anchor: nonce %d, anchored %d", r.nonce(t)-start, r.target.anchored.Load())
	}

	// A slowly growing log is anchored once an hour.
	r.appendLeaves(t, 1)
	r.a.tick(ctx)
	r.a.tick(ctx)
	if r.nonce(t) != start+1 {
		t.Fatal("anchored again before the hour")
	}
	// The fork's block time runs a little ahead of the test's clock.
	r.advance(time.Hour + time.Minute)
	r.a.tick(ctx)
	r.a.tick(ctx)
	if r.nonce(t) != start+2 || r.target.anchored.Load() != 2 {
		t.Fatalf("hourly anchor: nonce %d, anchored %d", r.nonce(t)-start, r.target.anchored.Load())
	}

	// 1,000 new leaves are anchored at the next tick.
	n := r.appendLeaves(t, anchorLeaves)
	r.a.tick(ctx)
	if r.nonce(t) != start+3 || r.target.anchored.Load() != uint64(n) {
		t.Fatalf("1000 leaves: nonce %d, anchored %d of %d", r.nonce(t)-start, r.target.anchored.Load(), n)
	}
	size, root := r.logRoot(t)
	if got := r.rootAt(t, uint64(size)); "0x"+hex.EncodeToString(got[:]) != root {
		t.Fatalf("rootAt(%d) = %x, the log's root is %s", size, got, root)
	}

	// Nothing new: the anchor is answered without a transaction.
	status, res, raw := r.post(t)
	if status != http.StatusOK || res.Fresh || res.Size != fmt.Sprint(size) || res.Root != root {
		t.Fatalf("anchor with nothing new: %d %s", status, raw)
	}
	if r.nonce(t) != start+3 {
		t.Fatal("anchored with nothing new")
	}

	// Two concurrent requests send one transaction and name it both.
	r.appendLeaves(t, 1)
	var wg sync.WaitGroup
	results := make([]anchorResult, 2)
	for i := range results {
		wg.Go(func() {
			status, res, raw := r.post(t)
			if status != http.StatusOK {
				t.Errorf("concurrent anchor: %d %s", status, raw)
			}
			results[i] = res
		})
	}
	wg.Wait()
	if r.nonce(t) != start+4 {
		t.Fatalf("two concurrent requests sent %d transactions", r.nonce(t)-start-3)
	}
	if results[0].Tx == nil || results[1].Tx == nil || *results[0].Tx != *results[1].Tx || results[0].Fresh == results[1].Fresh {
		t.Fatalf("concurrent anchors: %+v %+v", results[0], results[1])
	}

	// On-demand anchors: published checkpoint to receipt.
	var ms []float64
	for range 20 {
		r.appendLeaves(t, 1)
		begin := time.Now()
		status, res, raw := r.post(t)
		if status != http.StatusOK || !res.Fresh {
			t.Fatalf("on-demand anchor: %d %s", status, raw)
		}
		ms = append(ms, float64(time.Since(begin).Microseconds())/1000)
	}
	slices.Sort(ms)
	t.Logf("POST /anchor to receipt on the fork, 20 anchors: p50 %.0f ms, p95 %.0f ms", ms[9], ms[18])
}

func TestAnchorWaitsForBothLegs(t *testing.T) {
	r := newAnchorRig(t, "http://127.0.0.1:9")
	start := r.nonce(t)
	r.appendLeaves(t, 1)
	status, _, raw := r.post(t)
	if status != http.StatusServiceUnavailable || !strings.Contains(raw, `"tee_unavailable"`) {
		t.Fatalf("leg b down: %d %s", status, raw)
	}
	if r.nonce(t) != start {
		t.Fatal("anchored without leg b")
	}
}
