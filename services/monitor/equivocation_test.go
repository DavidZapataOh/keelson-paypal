package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"filippo.io/torchwood"
	"github.com/DavidZapataOh/keelson-paypal/internal/conformance"
	"golang.org/x/mod/sumdb/note"
)

// forkedLogs are two logs of one origin that share their first ten leaves
// and then diverge: a is cosigned by the witnesses, b by the same witness keys
// with their state wiped.
type forkedLogs struct {
	o          *origin
	srv        *logServer
	dirA, dirB string
	a, b       *testLog
	cpA10      []byte
	cpA20      []byte
	cpB15      []byte
	cpB20      []byte
}

func newForkedLogs(t *testing.T) *forkedLogs {
	t.Helper()
	vectors := loadVectors(t)
	keys := newLogKeys(t, testOrigin)
	ws := keys.startWitnesses(t, testOrigin, nil)
	p := witnessPolicy(keys.vkey, ws)
	f := &forkedLogs{dirA: filepath.Join(t.TempDir(), "a"), dirB: filepath.Join(t.TempDir(), "b")}
	f.a = openTestLog(t, f.dirA, keys.signer, p)
	f.cpA10 = f.a.append(t, freshLeaves(t, vectors["allow"], 10)...)
	f.a.close(t)
	copyDir(t, f.dirA, f.dirB)
	f.a = openTestLog(t, f.dirA, keys.signer, p)
	f.b = openTestLog(t, f.dirB, keys.signer, witnessPolicy(keys.vkey, keys.startWitnesses(t, testOrigin, ws)))
	f.cpA20 = f.a.append(t, freshLeaves(t, vectors["allow"], 10)...)
	f.cpB15 = f.b.append(t, freshLeaves(t, vectors["deny"], 5)...)
	f.cpB20 = f.b.append(t, freshLeaves(t, vectors["deny"], 5)...)
	f.srv = serveLog(t, f.dirA)
	f.o = testOriginAt(t, f.srv.URL, p)
	return f
}

func TestASplitViewIsCaughtWithinOneInterval(t *testing.T) {
	f := newForkedLogs(t)
	eqs, err := openEquivocations(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	var times []time.Duration
	for range 20 {
		f.srv.switchTo(f.dirA)
		m := startMonitor(t, t.TempDir(), f.o)
		m.waitFor(t, 10*time.Second, func(r Report) bool { return r.Size == 20 })
		// The fork is served at a random point of the polling cycle.
		jitter, _ := rand.Int(rand.Reader, big.NewInt(int64(pollInterval)))
		time.Sleep(time.Duration(jitter.Int64()))
		t0 := time.Now()
		f.srv.switchTo(f.dirB)
		e := m.equivocation(t, 2*time.Second)
		if _, err := eqs.add(e); err != nil {
			t.Fatal(err)
		}
		d := time.Since(t0)
		m.stop()
		times = append(times, d)
		if e.Kind != "same-size" {
			t.Fatalf("kind %q, want same-size", e.Kind)
		}
		a, _, errA := torchwood.VerifyCheckpoint([]byte(e.A), f.o.Policy)
		b, _, errB := torchwood.VerifyCheckpoint([]byte(e.B), f.o.Policy)
		if errA != nil || errB != nil || a.N != 20 || b.N != 20 || a.Hash == b.Hash {
			t.Fatalf("the proof's checkpoints: %v %v %v %v", a, errA, b, errB)
		}
		if d >= pollInterval*2 {
			t.Fatalf("the split view took %v to catch", d)
		}
	}
	slices.Sort(times)
	t.Logf("split view caught over %d runs: p50 %v, p95 %v, max %v", len(times), times[len(times)/2], times[len(times)*95/100], times[len(times)-1])
	if times[len(times)-1] >= time.Second {
		t.Fatalf("max detection time %v, budget 1s", times[len(times)-1])
	}
	if got := eqs.list(); len(got) != 1 {
		t.Fatalf("one fork pair gave %d proofs", len(got))
	}

	// A fork that grew past the monitor's view fails the consistency proof.
	f.srv.switchTo(f.dirA)
	m := startMonitor(t, t.TempDir(), f.o)
	m.waitFor(t, 10*time.Second, func(r Report) bool { return r.Size == 20 })
	f.b.append(t, freshLeaves(t, loadVectors(t)["deny"], 5)...)
	f.srv.switchTo(f.dirB)
	e := m.equivocation(t, 2*time.Second)
	if e.Kind != "inconsistent" || len(e.ConsistencyProof) == 0 {
		t.Fatalf("equivocation: %+v", e)
	}
}

// gossipServer serves a monitor whose followed origin is o and whose
// conformance origin is signed by the returned signer.
func gossipServer(t *testing.T, o *origin, dataDir string) (*httptest.Server, *monitor, note.Signer) {
	t.Helper()
	skey, vkey, err := note.GenerateKey(rand.Reader, conformance.Origin)
	if err != nil {
		t.Fatal(err)
	}
	s, err := note.NewSigner(skey)
	if err != nil {
		t.Fatal(err)
	}
	co, err := newOrigin(conformance.Origin, "", []byte("log "+vkey+"\nquorum none\n"))
	if err != nil {
		t.Fatal(err)
	}
	st, err := openState(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	eqs, err := openEquivocations(filepath.Join(dataDir, "equivocations"))
	if err != nil {
		t.Fatal(err)
	}
	cfg := &config{DataDir: dataDir, Poll: pollInterval, Conformance: co}
	if o != nil {
		cfg.Origins = []*origin{o}
	}
	m := newMonitor(cfg, st, eqs, http.DefaultClient, slog.New(slog.DiscardHandler))
	srv := httptest.NewServer(m.handler())
	t.Cleanup(srv.Close)
	return srv, m, s
}

func post(t *testing.T, srv *httptest.Server, body []byte) (int, map[string]string) {
	t.Helper()
	res, err := http.Post(srv.URL+"/gossip", "text/plain", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := map[string]string{}
	_ = json.Unmarshal(raw, &out)
	return res.StatusCode, out
}

func getJSON(t *testing.T, url string, v any) int {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("%s: Cache-Control %q", url, res.Header.Get("Cache-Control"))
	}
	_ = json.NewDecoder(res.Body).Decode(v)
	return res.StatusCode
}

func TestGossipedCheckpointsAreCheckedAgainstTheView(t *testing.T) {
	f := newForkedLogs(t)
	dataDir := t.TempDir()
	srv, m, cs := gossipServer(t, f.o, dataDir)
	// This test posts more checkpoints than one client may in a minute.
	m.limiter = newRateLimiter(100, time.Minute)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	t.Cleanup(func() { cancel(); <-done })
	go func() {
		defer close(done)
		Follow(ctx, f.o, m.st, pollInterval, nil, http.DefaultClient, make(chan Event, 16), slog.New(slog.DiscardHandler))
	}()
	deadline := time.Now().Add(10 * time.Second)
	for m.st.Get(testOrigin).Size != 20 {
		if time.Now().After(deadline) {
			t.Fatal("the follower did not reach size 20")
		}
		time.Sleep(10 * time.Millisecond)
	}

	for _, c := range []struct {
		name   string
		cp     []byte
		status int
		want   string
	}{
		{"the same checkpoint", f.cpA20, 200, "consistent"},
		{"an older checkpoint of the same log", f.cpA10, 200, "behind"},
		{"a fork at the monitor's size", f.cpB20, 409, ""},
		{"an older checkpoint of a fork", f.cpB15, 409, ""},
	} {
		status, out := post(t, srv, c.cp)
		if status != c.status || out["status"] != c.want {
			t.Fatalf("%s: %d %v", c.name, status, out)
		}
		if status == 409 {
			var e Equivocation
			if getJSON(t, srv.URL+"/equivocations/"+out["equivocation"], &e) != 200 || e.Origin != testOrigin {
				t.Fatalf("%s: proof %+v", c.name, e)
			}
		}
	}
	// A fork ahead of what the log published cannot be checked yet.
	cpB25 := f.b.append(t, freshLeaves(t, loadVectors(t)["deny"], 5)...)
	if status, out := post(t, srv, cpB25); status != 200 || out["status"] != "ahead" {
		t.Fatalf("a checkpoint ahead of the log: %d %v", status, out)
	}
	// Replaying a checkpoint that agrees is answered from memory.
	if status, out := post(t, srv, f.cpA10); status != 200 || out["status"] != "behind" {
		t.Fatalf("a replayed checkpoint: %d %v", status, out)
	}

	var cp []byte
	res, err := http.Get(srv.URL + "/checkpoints/" + testOrigin)
	if err == nil {
		cp, _ = io.ReadAll(res.Body)
		res.Body.Close()
	}
	if checkpointBody(cp) != checkpointBody(f.cpA20) {
		t.Fatalf("/checkpoints: %q", cp)
	}

	// The conformance origin is known only through gossip.
	if status, out := post(t, srv, conformance.SignedCheckpoint(cs, 5, conformance.Tree(5))); status != 200 || out["status"] != "ahead" {
		t.Fatalf("first conformance checkpoint: %d %v", status, out)
	}
	if status, out := post(t, srv, conformance.SignedCheckpoint(cs, 6, conformance.Tree(6))); status != 200 || out["status"] != "ahead" {
		t.Fatalf("newer conformance checkpoint: %d %v", status, out)
	}
	if status, out := post(t, srv, conformance.SignedCheckpoint(cs, 5, conformance.Tree(5))); status != 200 || out["status"] != "consistent" {
		t.Fatalf("known conformance checkpoint: %d %v", status, out)
	}
	fork := conformance.Tree(5)
	fork[0] ^= 1
	status, out := post(t, srv, conformance.SignedCheckpoint(cs, 5, fork))
	if status != 409 {
		t.Fatalf("forked conformance checkpoint: %d %v", status, out)
	}
	var e Equivocation
	getJSON(t, srv.URL+"/equivocations/"+out["equivocation"], &e)
	if e.Kind != "same-size" || e.Origin != conformance.Origin {
		t.Fatalf("proof: %+v", e)
	}
	for _, n := range []string{e.A, e.B} {
		if _, _, err := torchwood.VerifyCheckpoint([]byte(n), m.cfg.Conformance.LogPolicy); err != nil {
			t.Fatalf("the proof's checkpoint does not verify: %v", err)
		}
	}

	other := newLogKeys(t, conformance.Origin)
	if status, out := post(t, srv, conformance.SignedCheckpoint(other.signer, 7, conformance.Tree(7))); status != 422 {
		t.Fatalf("a checkpoint signed by another key: %d %v", status, out)
	}
	unknown := newLogKeys(t, "example.com/log")
	signed, _ := note.Sign(&note.Note{Text: "example.com/log\n1\n" + strings.Repeat("A", 43) + "=\n"}, unknown.signer)
	if status, out := post(t, srv, signed); status != 422 {
		t.Fatalf("an unknown origin: %d %v", status, out)
	}

	var list []EquivocationSummary
	getJSON(t, srv.URL+"/equivocations", &list)
	if len(list) != 3 {
		t.Fatalf("equivocations: %+v", list)
	}
	var r FullReport
	getJSON(t, srv.URL+"/report", &r)
	if len(r.Origins) != 1 || r.Origins[0].Size != 20 || len(r.Equivocations) != 3 || r.Checks.TEESigners != "not-enabled" || r.Checks.Anchors != "not-enabled" {
		t.Fatalf("report: %+v", r)
	}

	// The proofs survive a restart and are never rewritten.
	reopened, err := openEquivocations(filepath.Join(dataDir, "equivocations"))
	if err != nil || len(reopened.list()) != 3 {
		t.Fatalf("reopened: %v %v", reopened, err)
	}
}

func TestGossipIsRateLimitedPerClient(t *testing.T) {
	srv, _, cs := gossipServer(t, nil, t.TempDir())
	for i := range gossipPerMinute {
		if status, out := post(t, srv, conformance.SignedCheckpoint(cs, uint64(i+1), conformance.Tree(uint64(i+1)))); status != 200 {
			t.Fatalf("post %d: %d %v", i+1, status, out)
		}
	}
	if status, _ := post(t, srv, conformance.SignedCheckpoint(cs, 1, conformance.Tree(1))); status != http.StatusTooManyRequests {
		t.Fatalf("post %d: %d, want 429", gossipPerMinute+1, status)
	}
	big := make([]byte, maxGossipBytes+1)
	srv2, _, _ := gossipServer(t, nil, t.TempDir())
	if status, _ := post(t, srv2, big); status != http.StatusRequestEntityTooLarge {
		t.Fatalf("an oversized body: %d", status)
	}
}
