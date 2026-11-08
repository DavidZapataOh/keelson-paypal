//go:build live

package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"filippo.io/torchwood"
	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi/bind/v2"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"golang.org/x/mod/sumdb/tlog"
)

// The CheckpointAnchor on Arbitrum Sepolia.
const liveCheckpointAnchor = "0x049621749722D0660d5026456F25192fBD9A57ab"

func liveAnchor(t *testing.T) (*ethclient.Client, *bind.BoundContract) {
	t.Helper()
	rpcURL := os.Getenv("ARBITRUM_SEPOLIA_RPC_URL")
	if rpcURL == "" {
		rpcURL = "https://sepolia-rollup.arbitrum.io/rpc"
	}
	c, err := ethclient.Dial(rpcURL)
	if err != nil {
		t.Fatal(err)
	}
	return c, bind.NewBoundContract(common.HexToAddress(liveCheckpointAnchor), anchorABI, c, c, c)
}

func liveLatest(t *testing.T, a *bind.BoundContract, origin string) (uint64, [32]byte) {
	t.Helper()
	var out []any
	if err := a.Call(&bind.CallOpts{}, &out, "latest", crypto.Keccak256Hash([]byte(origin))); err != nil {
		t.Fatal(err)
	}
	return out[0].(uint64), out[1].([32]byte)
}

// TestLiveSandboxAnchorIsTheLogsTree checks the latest sandbox anchor against
// the public tiles: its root is the log's root at that size, and the last leaf
// of that tree is proven included through the contract.
func TestLiveSandboxAnchorIsTheLogsTree(t *testing.T) {
	ctx := context.Background()
	_, a := liveAnchor(t)
	o := liveOrigins(t)[0]
	if o.spec.Name != "log.keelson.finance/alibi/2026-1" {
		t.Fatalf("first live origin is %s", o.spec.Name)
	}
	size, root := liveLatest(t, a, o.spec.Name)
	if size == 0 {
		t.Skip("the sandbox origin has no anchor yet")
	}
	c := liveCheckpoint(t, o)
	if uint64(c.N) < size {
		t.Fatalf("anchored size %d is beyond the published %d", size, c.N)
	}
	tf, err := torchwood.NewTileFetcher(o.base)
	if err != nil {
		t.Fatal(err)
	}
	r := torchwood.TileHashReaderWithContext(ctx, c.Tree, tf)
	h, err := tlog.TreeHash(int64(size), r)
	if err != nil {
		t.Fatal(err)
	}
	if h != tlog.Hash(root) {
		t.Fatalf("anchored root at %d is %x, the log's is %x", size, root, h)
	}
	last := int64(size) - 1
	leaf, err := r.ReadHashes([]int64{tlog.StoredHashIndex(0, last)})
	if err != nil {
		t.Fatal(err)
	}
	p, err := tlog.ProveRecord(int64(size), last, torchwood.TileHashReaderWithContext(ctx, tlog.Tree{N: int64(size), Hash: h}, tf))
	if err != nil {
		t.Fatal(err)
	}
	proof := make([][32]byte, len(p))
	for i := range p {
		proof[i] = p[i]
	}
	var out []any
	if err := a.Call(&bind.CallOpts{}, &out, "verifyInclusion", crypto.Keccak256Hash([]byte(o.spec.Name)), size, uint64(last), [32]byte(leaf[0]), proof); err != nil {
		t.Fatal(err)
	}
	if !out[0].(bool) {
		t.Fatalf("leaf %d is not proven in the anchored tree of size %d", last, size)
	}
}

type liveCase struct {
	Name                    string     `json:"name"`
	OriginHash              string     `json:"originHash"`
	Size                    uint64     `json:"size"`
	Root                    string     `json:"root"`
	ConsistencyFromPrevious []string   `json:"consistencyFromPrevious"`
	SigTdx                  string     `json:"sigTdx"`
	SigNitro                string     `json:"sigNitro"`
	SignedNote              string     `json:"signedNote"`
	proof                   [][32]byte `json:"-"`
}

func liveCases(t *testing.T) map[string]liveCase {
	t.Helper()
	raw, err := os.ReadFile("../../contracts/test/vectors/checkpoints.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []liveCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	out := map[string]liveCase{}
	for _, c := range f.Cases {
		for _, h := range c.ConsistencyFromPrevious {
			c.proof = append(c.proof, common.HexToHash(h))
		}
		out[c.Name] = c
	}
	return out
}

// revertOf simulates anchoring c with proof on the live contract and returns
// the error name it reverts with, or "" if it would succeed.
func revertOf(t *testing.T, client *ethclient.Client, c liveCase, proof [][32]byte) string {
	t.Helper()
	sigs := append(common.FromHex(c.SigTdx), common.FromHex(c.SigNitro)...)
	data, err := anchorABI.Pack("anchor", common.HexToHash(c.OriginHash), c.Size, common.HexToHash(c.Root), proof, sigs, []byte(c.SignedNote))
	if err != nil {
		t.Fatal(err)
	}
	to := common.HexToAddress(liveCheckpointAnchor)
	_, err = client.CallContract(context.Background(), ethereum.CallMsg{To: &to, Data: data}, nil)
	if err == nil {
		return ""
	}
	var de interface{ ErrorData() any }
	if !errors.As(err, &de) {
		t.Fatal(err)
	}
	s, _ := de.ErrorData().(string)
	for name, e := range anchorABI.Errors {
		if len(s) >= 10 && s[:10] == hexutil.Encode(e.ID[:4]) {
			return name
		}
	}
	t.Fatalf("unknown revert %s", s)
	return ""
}

// TestLiveRewrittenHistoryReverts replays, against the live state, the drill
// that anchored the conformance tree T at 8 and 16: T' at 16, which rewrites
// leaves of T, and T at 16 again are refused.
func TestLiveRewrittenHistoryReverts(t *testing.T) {
	client, a := liveAnchor(t)
	cases := liveCases(t)
	t8, t16, fork16 := cases["conformance-8"], cases["conformance-16"], cases["fork-16"]
	size, root := liveLatest(t, a, "log.keelson.finance/conformance/2026-1")
	if size == 0 {
		t.Skip("the conformance drill has not run yet")
	}
	if size != t16.Size || common.Hash(root) != common.HexToHash(t16.Root) {
		t.Fatalf("the conformance origin is anchored at %d, not at T's 16", size)
	}
	var out []any
	if err := a.Call(&bind.CallOpts{}, &out, "rootAt", common.HexToHash(t8.OriginHash), t8.Size); err != nil {
		t.Fatal(err)
	}
	if common.Hash(out[0].([32]byte)) != common.HexToHash(t8.Root) {
		t.Fatal("T at 8 is not anchored")
	}
	if got := revertOf(t, client, fork16, fork16.proof); got != "InconsistentCheckpoint" {
		t.Fatalf("T' at 16: %q, want InconsistentCheckpoint", got)
	}
	if got := revertOf(t, client, t16, t16.proof); got != "AlreadyAnchored" {
		t.Fatalf("T at 16 again: %q, want AlreadyAnchored", got)
	}
}
