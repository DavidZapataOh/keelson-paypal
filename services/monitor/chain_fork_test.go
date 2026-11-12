//go:build fork

package main

import (
	"context"
	"fmt"
	"log/slog"
	"math/big"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/rpc"
)

// sepoliaRPC is the Arbitrum Sepolia endpoint the fork reads from.
func sepoliaRPC() string {
	if u := os.Getenv("ARBITRUM_SEPOLIA_RPC_URL"); u != "" {
		return u
	}
	return "https://sepolia-rollup.arbitrum.io/rpc"
}

// anvilFork is an anvil fork of Arbitrum Sepolia at its latest block.
type anvilFork struct {
	URL string
	rpc *rpc.Client
}

func startFork(t testing.TB) *anvilFork {
	t.Helper()
	port := freePort(t)
	cmd := exec.Command("anvil", "--fork-url", sepoliaRPC(), "--port", fmt.Sprint(port), "--silent", "--retries", "10")
	if err := cmd.Start(); err != nil {
		t.Fatalf("anvil: %v", err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	c, err := rpc.Dial(url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	deadline := time.Now().Add(60 * time.Second)
	for {
		var n string
		if err := c.Call(&n, "eth_blockNumber"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("anvil did not start")
		}
		time.Sleep(200 * time.Millisecond)
	}
	return &anvilFork{URL: url, rpc: c}
}

func (a *anvilFork) call(t testing.TB, result any, method string, args ...any) {
	t.Helper()
	if err := a.rpc.Call(result, method, args...); err != nil {
		t.Fatalf("%s: %v", method, err)
	}
}

func (a *anvilFork) storage(t testing.TB, addr common.Address, slot common.Hash) common.Hash {
	t.Helper()
	var v common.Hash
	a.call(t, &v, "eth_getStorageAt", addr, slot, "latest")
	return v
}

func (a *anvilFork) setStorage(t testing.TB, addr common.Address, slot, value common.Hash) {
	t.Helper()
	a.call(t, nil, "anvil_setStorageAt", addr, slot, value)
}

// sendAs sends a transaction from an impersonated account and fails the test
// unless it succeeds.
func (a *anvilFork) sendAs(t testing.TB, from, to common.Address, data []byte) {
	t.Helper()
	a.call(t, nil, "anvil_impersonateAccount", from)
	a.call(t, nil, "anvil_setBalance", from, "0x56BC75E2D63100000")
	var hash common.Hash
	a.call(t, &hash, "eth_sendTransaction", map[string]any{"from": from, "to": to, "data": hexutilBytes(data)})
	var receipt *struct {
		Status string `json:"status"`
	}
	for deadline := time.Now().Add(30 * time.Second); receipt == nil && time.Now().Before(deadline); {
		a.call(t, &receipt, "eth_getTransactionReceipt", hash)
		time.Sleep(100 * time.Millisecond)
	}
	if receipt == nil || receipt.Status != "0x1" {
		t.Fatalf("transaction %s: %+v", hash, receipt)
	}
}

func hexutilBytes(b []byte) string { return fmt.Sprintf("0x%x", b) }

func word(v uint64) []byte { return common.LeftPadBytes(new(big.Int).SetUint64(v).Bytes(), 32) }

// mappingSlot is the storage slot of m[key] for a mapping at slot.
func mappingSlot(key []byte, slot common.Hash) common.Hash {
	return crypto.Keccak256Hash(common.LeftPadBytes(key, 32), slot.Bytes())
}

// CheckpointAnchor's storage: _latest at slot 0, rootAt at slot 1.
func latestSlot(origin string) common.Hash {
	return mappingSlot(crypto.Keccak256([]byte(origin)), common.BigToHash(big.NewInt(0)))
}

func rootAtSlot(origin string, size uint64) common.Hash {
	inner := mappingSlot(crypto.Keccak256([]byte(origin)), common.BigToHash(big.NewInt(1)))
	return mappingSlot(word(size), inner)
}

// anchoredSizes lists the sizes the origin was anchored at, oldest first.
func anchoredSizes(t testing.TB, ct *chainTrust, origin string) []uint64 {
	t.Helper()
	c, err := ethclient.Dial(sepoliaRPC())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	logs, err := c.FilterLogs(context.Background(), ethereum.FilterQuery{
		FromBlock: new(big.Int).SetUint64(ct.FromBlock),
		Addresses: []common.Address{ct.CheckpointAnchor},
		Topics: [][]common.Hash{
			{crypto.Keccak256Hash([]byte("CheckpointAnchored(bytes32,uint64,bytes32,bytes32)"))},
			{crypto.Keccak256Hash([]byte(origin))},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var sizes []uint64
	for _, l := range logs {
		sizes = append(sizes, new(big.Int).SetBytes(l.Data[:32]).Uint64())
	}
	return sizes
}

// realFollower follows the production log's origin, checked against chain,
// up to the log's current size.
func realFollower(t testing.TB, path string, chainRPC string) *follower {
	t.Helper()
	dir := t.TempDir()
	cfg, err := loadConfig(func(k string) string {
		if k == "MONITOR_DATA_DIR" {
			return dir
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	var o *origin
	for _, c := range cfg.Origins {
		if c.Name == logHost+"/"+path {
			o = c
		}
	}
	if chainRPC != "" {
		ct := *o.Chain
		ct.RPC = []string{chainRPC}
		o.Chain = &ct
	}
	st, err := openState(dir)
	if err != nil {
		t.Fatal(err)
	}
	f := newFollower(o, st, nil, newLogClient(), make(chan Event, 64), slog.New(slog.DiscardHandler))
	ctx := context.Background()
	for i := 0; ; i++ {
		if err := f.check(ctx); err != nil {
			t.Fatalf("follow %s: %v", o.Name, err)
		}
		if st.Get(o.Name).Size > 0 || path == "alibi-live/2026-1" || i > 20 {
			break
		}
	}
	if o.Chain.CheckpointAnchor != (common.Address{}) {
		if f.chain, err = newChainReader(ctx, o.Chain); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(f.chain.close)
	}
	return f
}
