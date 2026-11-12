//go:build page

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"

	"github.com/DavidZapataOh/keelson-paypal/internal/conformance"
)

// TestPageFixture serves the monitor and its page over a real local log with
// witnesses, for the browser tests in test/page.test.ts. It prints the URLs
// and serves until POST /stop on the control server.
func TestPageFixture(t *testing.T) {
	vectors := loadVectors(t)
	keys := newLogKeys(t, testOrigin)
	ws := keys.startWitnesses(t, testOrigin, nil)
	p := witnessPolicy(keys.vkey, ws)
	dir := filepath.Join(t.TempDir(), "log")
	l := openTestLog(t, dir, keys.signer, p)
	leaves := freshLeaves(t, vectors["allow"], 7)
	leaves = append(leaves, vectors["degraded"].Leaf)
	l.append(t, append(leaves, freshLeaves(t, vectors["deny"], 22)...)...)
	logSrv := serveLog(t, dir)
	o := testOriginAt(t, logSrv.URL, p)

	dataDir := t.TempDir()
	_, m, cs := gossipServer(t, o, dataDir)
	page, err := newPage(m.cfg)
	if err != nil {
		t.Fatal(err)
	}
	m.page = page
	monitorSrv := httptest.NewServer(m.handler())
	t.Cleanup(monitorSrv.Close)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	t.Cleanup(func() { cancel(); <-done })
	events := make(chan Event, 64)
	go func() {
		defer close(done)
		Follow(ctx, o, m.st, pollInterval, nil, http.DefaultClient, events, slog.New(slog.DiscardHandler))
	}()
	go func() {
		for e := range events {
			if e.Equivocation != nil {
				_, _ = m.recordEquivocation(e.Equivocation)
			}
		}
	}()

	// A conformance drill, so the page lists one.
	fork := conformance.Tree(3)
	fork[0] ^= 1
	for _, cp := range [][]byte{conformance.SignedCheckpoint(cs, 3, conformance.Tree(3)), conformance.SignedCheckpoint(cs, 3, fork)} {
		if _, _, err := m.gossip(ctx, cp); err != nil {
			t.Fatal(err)
		}
	}

	prodURL := productionMonitor(t, ctx)

	stop := make(chan struct{})
	control := http.NewServeMux()
	control.HandleFunc("POST /append", func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.URL.Query().Get("n"))
		l.append(t, freshLeaves(t, vectors["allow"], max(n, 1))...)
		w.WriteHeader(http.StatusNoContent)
	})
	control.HandleFunc("POST /stop", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
		close(stop)
	})
	controlSrv := httptest.NewServer(control)
	t.Cleanup(controlSrv.Close)

	out, _ := json.Marshal(map[string]string{"monitor": monitorSrv.URL, "log": logSrv.URL, "control": controlSrv.URL, "production": prodURL})
	fmt.Printf("PAGE_FIXTURE %s\n", out)
	<-stop
}

// productionMonitor serves a monitor of the production origins, as deployed:
// it follows log.keelson.finance and checks it against the chain.
func productionMonitor(t *testing.T, ctx context.Context) string {
	dataDir := t.TempDir()
	cfg, err := loadConfig(func(k string) string {
		if k == "MONITOR_DATA_DIR" {
			return dataDir
		}
		return os.Getenv(k)
	})
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
	hc := newLogClient()
	m := newMonitor(cfg, st, eqs, hc, slog.New(slog.DiscardHandler))
	if m.page, err = newPage(cfg); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(m.handler())
	t.Cleanup(srv.Close)
	events := make(chan Event, 64)
	go func() {
		for range events {
		}
	}()
	ctx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	t.Cleanup(func() { cancel(); wg.Wait() })
	for _, o := range cfg.Origins {
		wg.Go(func() { Follow(ctx, o, st, cfg.Poll, cfg.Sigsum, hc, events, slog.New(slog.DiscardHandler)) })
	}
	return srv.URL
}
