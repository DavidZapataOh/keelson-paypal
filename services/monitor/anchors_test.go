//go:build fork

package main

import (
	"context"
	"encoding/binary"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

const sandbox = "alibi/2026-1"

// moveLatestBack points the origin's latest anchor at an earlier anchored
// size, so the check has to prove consistency instead of comparing roots.
func moveLatestBack(t *testing.T, fork *anvilFork, f *follower) uint64 {
	t.Helper()
	sizes := anchoredSizes(t, f.o.Chain, f.o.Name)
	if len(sizes) < 2 {
		t.Skip("the origin has fewer than two anchors")
	}
	prev := sizes[len(sizes)-2]
	slot := latestSlot(f.o.Name)
	w := fork.storage(t, f.o.Chain.CheckpointAnchor, slot)
	binary.BigEndian.PutUint64(w[24:], prev)
	fork.setStorage(t, f.o.Chain.CheckpointAnchor, slot, w)
	return prev
}

func TestAnchorConsistentWithView(t *testing.T) {
	fork := startFork(t)
	f := realFollower(t, sandbox, fork.URL)
	ctx := context.Background()
	cur := f.st.Get(f.o.Name)

	start := time.Now()
	c, fd := f.checkAnchor(ctx, cur)
	t.Logf("anchor check: %s at size %d against view %d in %v", c.Status, c.Size, cur.Size, time.Since(start))
	if fd != nil || (c.Status != "consistent" && c.Status != "ahead") || c.Size == 0 || c.ChainID != 421614 {
		t.Fatalf("latest anchor: %+v %+v", c, fd)
	}

	prev := moveLatestBack(t, fork, f)
	start = time.Now()
	c, fd = f.checkAnchor(ctx, cur)
	t.Logf("anchor check with a consistency proof from %d to %d: %v", prev, cur.Size, time.Since(start))
	if fd != nil || c.Status != "consistent" || c.Size != prev {
		t.Fatalf("earlier anchor: %+v %+v", c, fd)
	}
}

func TestAnchorRootMismatchIsAFinding(t *testing.T) {
	fork := startFork(t)
	f := realFollower(t, sandbox, fork.URL)
	ctx := context.Background()
	cur := f.st.Get(f.o.Name)
	for _, back := range []bool{false, true} {
		size, _, _, err := f.chain.latestAnchor(ctx, f.o.Name)
		if err != nil {
			t.Fatal(err)
		}
		if back {
			size = moveLatestBack(t, fork, f)
		} else if size > cur.Size {
			continue
		}
		slot := rootAtSlot(f.o.Name, size)
		root := fork.storage(t, f.o.Chain.CheckpointAnchor, slot)
		if root == (common.Hash{}) {
			t.Fatalf("no root at size %d", size)
		}
		root[0] ^= 1
		fork.setStorage(t, f.o.Chain.CheckpointAnchor, slot, root)

		c, fd := f.checkAnchor(ctx, cur)
		if fd == nil || fd.Kind != "anchor.root" || c.Status != "inconsistent" {
			t.Fatalf("flipped root at size %d (back %v): %+v %+v", size, back, c, fd)
		}
	}
}

func TestAnchorAheadWaits(t *testing.T) {
	fork := startFork(t)
	f := realFollower(t, sandbox, fork.URL)
	size, _, _, err := f.chain.latestAnchor(context.Background(), f.o.Name)
	if err != nil {
		t.Fatal(err)
	}
	cur := f.st.Get(f.o.Name)
	cur.Size = size - 1
	c, fd := f.checkAnchor(context.Background(), cur)
	if fd != nil || c.Status != "ahead" {
		t.Fatalf("%+v %+v", c, fd)
	}
}

func TestAnchorRPCDownIsNotAFinding(t *testing.T) {
	f := realFollower(t, sandbox, "http://127.0.0.1:1")
	ctx := context.Background()
	cur := f.st.Get(f.o.Name)
	c, fd := f.checkAnchor(ctx, cur)
	if fd != nil || c.Status != "error" || c.Error == "" {
		t.Fatalf("anchor: %+v %+v", c, fd)
	}
	sc, _, fds := f.checkSigners(ctx, cur)
	if len(fds) != 0 || sc.Status != "error" || sc.Next != 0 {
		t.Fatalf("signers: %+v %+v", sc, fds)
	}
	f.checkChain(ctx)
	r := buildReport(f.o, f.st)
	if len(r.Findings) != 0 || r.Anchor.Status != "error" || r.Signers.Status != "error" {
		t.Fatalf("report: %+v", r)
	}
}

func TestLiveOriginNotDeployed(t *testing.T) {
	f := realFollower(t, "alibi-live/2026-1", "")
	f.checkChain(context.Background())
	r := buildReport(f.o, f.st)
	if r.Anchor == nil || r.Anchor.Status != "not-deployed" || r.Anchor.ChainID != 42161 || r.Signers.Status != "not-deployed" {
		t.Fatalf("%+v", r)
	}
}
