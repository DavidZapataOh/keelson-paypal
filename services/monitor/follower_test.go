package main

import (
	"path/filepath"
	"slices"
	"sort"
	"testing"
	"time"

	"filippo.io/torchwood"
)

func TestFollowerAuditsEveryCheckpointAndLeaf(t *testing.T) {
	vectors := loadVectors(t)
	keys := newLogKeys(t, testOrigin)
	ws := keys.startWitnesses(t, testOrigin, nil)
	p := witnessPolicy(keys.vkey, ws)
	dir := t.TempDir()
	l := openTestLog(t, dir, keys.signer, p)
	srv := serveLog(t, dir)
	o := testOriginAt(t, srv.URL, p)

	leaves := freshLeaves(t, vectors["allow"], 120)
	leaves = append(leaves, vectors["degraded"].Leaf)
	leaves = append(leaves, freshLeaves(t, vectors["deny"], 79)...)
	cp := l.append(t, leaves...)
	if _, _, err := torchwood.VerifyCheckpoint(cp, o.Policy); err != nil {
		t.Fatalf("the log's checkpoint does not satisfy its policy: %v", err)
	}

	dataDir := t.TempDir()
	m := startMonitor(t, dataDir, o)
	r := m.waitFor(t, 30*time.Second, func(r Report) bool { return r.Size == 200 })
	if r.LeavesAudited != 200 || len(r.Cosigners) < 2 || len(r.Findings) != 0 {
		t.Fatalf("report: %+v", r)
	}
	if !slices.Equal(r.DegradedLeaves, []uint64{120}) {
		t.Fatalf("degraded leaves: %v, want [120]", r.DegradedLeaves)
	}

	// Lag from a checkpoint being published to the monitor reporting it.
	var lags []time.Duration
	for i := range 20 {
		l.append(t, freshLeaves(t, vectors["allow"], 1)...)
		published := time.Now()
		m.waitFor(t, 10*time.Second, func(r Report) bool { return r.Size == uint64(201+i) })
		lags = append(lags, time.Since(published))
	}
	sort.Slice(lags, func(i, j int) bool { return lags[i] < lags[j] })
	t.Logf("follower lag over %d checkpoints: p50 %v, p95 %v, max %v", len(lags), lags[len(lags)/2], lags[len(lags)*95/100], lags[len(lags)-1])

	// A leaf written past admission with an extra key is reported at its index.
	bad := rewrite(t, vectors["allow"].Leaf, func(m map[string]any) {
		m["alibi_id"] = newULID()
		m["extra"] = "x"
	})
	l.append(t, bad)
	r = m.waitFor(t, 10*time.Second, func(r Report) bool { return r.Size == 221 })
	if len(r.Findings) != 1 || r.Findings[0].Kind != "leaf.format" || r.Findings[0].Index == nil || *r.Findings[0].Index != 220 {
		t.Fatalf("findings: %+v", r.Findings)
	}

	// A restart resumes from the verified state without auditing again.
	m.stop()
	m = startMonitor(t, dataDir, o)
	r = m.waitFor(t, 10*time.Second, func(r Report) bool { return !r.VerifiedAt.IsZero() })
	if r.Size != 221 || r.LeavesAudited != 221 || !slices.Equal(r.DegradedLeaves, []uint64{120}) {
		t.Fatalf("after a restart: %+v", r)
	}

	// The log restarted with another key under the same origin is reported,
	// and its checkpoints are not followed.
	l.close(t)
	other := newLogKeys(t, testOrigin)
	l = openTestLog(t, dir, other.signer, nil)
	l.append(t, freshLeaves(t, vectors["allow"], 1)...)
	r = m.waitFor(t, 10*time.Second, func(r Report) bool { return hasFinding(r, "checkpoint.signature") })
	if r.Size != 221 || r.Error == "" {
		t.Fatalf("followed a checkpoint signed by another key: %+v", r)
	}
	if got := m.st.Get(testOrigin); got.Size != 221 {
		t.Fatalf("stored size %d, want 221", got.Size)
	}
}

func TestFollowerCatchesARolledBackLog(t *testing.T) {
	vectors := loadVectors(t)
	keys := newLogKeys(t, testOrigin)
	ws := keys.startWitnesses(t, testOrigin, nil)
	p := witnessPolicy(keys.vkey, ws)
	dir := filepath.Join(t.TempDir(), "log")
	l := openTestLog(t, dir, keys.signer, p)
	srv := serveLog(t, dir)
	o := testOriginAt(t, srv.URL, p)

	l.append(t, freshLeaves(t, vectors["allow"], 20)...)
	l.close(t)
	snapshot := filepath.Join(t.TempDir(), "snapshot")
	copyDir(t, dir, snapshot)
	l = openTestLog(t, dir, keys.signer, p)
	l.append(t, freshLeaves(t, vectors["allow"], 20)...)

	dataDir := t.TempDir()
	m := startMonitor(t, dataDir, o)
	m.waitFor(t, 10*time.Second, func(r Report) bool { return r.Size == 40 })
	m.stop()

	// The operator restores the snapshot. The witnesses refuse to cosign a
	// fork of what they saw, so it is cosigned by the same witness keys with
	// their state wiped.
	l.close(t)
	rolled := filepath.Join(t.TempDir(), "rolled")
	copyDir(t, snapshot, rolled)
	colluding := keys.startWitnesses(t, testOrigin, ws)
	l = openTestLog(t, rolled, keys.signer, witnessPolicy(keys.vkey, colluding))
	srv.switchTo(rolled)

	m = startMonitor(t, dataDir, o)
	r := m.waitFor(t, 10*time.Second, func(r Report) bool { return hasFinding(r, "checkpoint.rollback") })
	if r.Size != 40 {
		t.Fatalf("a rollback moved the monitor: %+v", r)
	}

	l.append(t, freshLeaves(t, vectors["deny"], 30)...)
	e := m.equivocation(t, 10*time.Second)
	if e.Kind != "inconsistent" || e.Origin != testOrigin || len(e.ConsistencyProof) == 0 {
		t.Fatalf("equivocation: %+v", e)
	}
	a, _, errA := torchwood.VerifyCheckpoint([]byte(e.A), o.Policy)
	b, _, errB := torchwood.VerifyCheckpoint([]byte(e.B), o.Policy)
	if errA != nil || errB != nil || a.N != 40 || b.N != 50 {
		t.Fatalf("the proof's checkpoints: %d %v, %d %v", a.N, errA, b.N, errB)
	}
	r = m.report()
	if r.Size != 40 || !hasFinding(r, "equivocation") {
		t.Fatalf("report: %+v", r)
	}
}
