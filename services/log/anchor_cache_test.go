package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi/bind/v2"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/transparency-dev/tessera"
)

// sizedReader is a log whose published checkpoint has n leaves.
type sizedReader struct {
	tessera.LogReader
	n atomic.Int64
}

func (r *sizedReader) ReadCheckpoint(context.Context) ([]byte, error) {
	root := base64.StdEncoding.EncodeToString(make([]byte, 32))
	return fmt.Appendf(nil, "test.origin\n%d\n%s\n\n— sig\n", r.n.Load(), root), nil
}

// TestAnchorTickReadsTheChainOnlyWhenDue checks that the anchorer keeps the
// latest anchor in memory: one CheckpointAnchor.latest at startup, then none
// while nothing is due.
func TestAnchorTickReadsTheChainOnlyWhenDue(t *testing.T) {
	at := time.Unix(1_800_000_000, 0)
	var calls atomic.Int32
	s, _ := rpcServer(t, func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Method != "eth_call" {
			t.Errorf("unexpected %s", req.Method)
		}
		calls.Add(1)
		out, err := anchorABI.Methods["latest"].Outputs.Pack(uint64(10), [32]byte{}, big.NewInt(at.Unix()))
		if err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":"0x%s"}`, req.ID, hex.EncodeToString(out))
	})
	client, err := dialRPC(context.Background(), []string{s.URL})
	if err != nil {
		t.Fatal(err)
	}
	reader := &sizedReader{}
	reader.n.Store(10)
	o := &origin{name: "test.origin", chainID: 421614, reader: reader}
	target := &anchorTarget{
		origin:   o,
		hash:     crypto.Keccak256Hash([]byte(o.name)),
		chainID:  o.chainID,
		client:   client,
		contract: bind.NewBoundContract(common.Address{1}, anchorABI, client, client, client),
	}
	now := at.Add(time.Minute)
	a := &anchorer{
		targets: map[string]*anchorTarget{o.name: target},
		log:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		clock:   func() time.Time { return now },
	}
	ctx := context.Background()

	for range 5 {
		a.tick(ctx)
	}
	if calls.Load() != 1 || target.anchored.Load() != 10 {
		t.Fatalf("five idle ticks: %d chain reads, anchored %d", calls.Load(), target.anchored.Load())
	}

	// A grown log is not due before the hour: still no chain read.
	reader.n.Store(11)
	a.tick(ctx)
	if calls.Load() != 1 {
		t.Fatalf("a grown log before the hour read the chain: %d reads", calls.Load())
	}
}
