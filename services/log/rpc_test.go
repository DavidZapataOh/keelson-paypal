package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func rpcServer(t *testing.T, handler http.HandlerFunc) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		handler(w, r)
	}))
	t.Cleanup(s.Close)
	return s, &hits
}

func blockNumber(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":"0x2a"}`))
}

func TestDialRPCFallsBack(t *testing.T) {
	defer func(d time.Duration) { rpcAttemptTimeout = d }(rpcAttemptTimeout)
	rpcAttemptTimeout = 200 * time.Millisecond
	for name, primary := range map[string]http.HandlerFunc{
		"rate limit": func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "Monthly capacity limit exceeded", http.StatusTooManyRequests)
		},
		"server error": func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "bad gateway", http.StatusBadGateway)
		},
		"timeout": func(http.ResponseWriter, *http.Request) {
			time.Sleep(time.Second)
		},
	} {
		t.Run(name, func(t *testing.T) {
			p, pHits := rpcServer(t, primary)
			s, sHits := rpcServer(t, blockNumber)
			c, err := dialRPC(context.Background(), []string{p.URL, s.URL})
			if err != nil {
				t.Fatal(err)
			}
			n, err := c.BlockNumber(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if n != 42 || pHits.Load() != 1 || sHits.Load() != 1 {
				t.Fatalf("block %d, primary hits %d, secondary hits %d", n, pHits.Load(), sHits.Load())
			}
		})
	}
}

func TestDialRPCPrefersPrimary(t *testing.T) {
	p, pHits := rpcServer(t, blockNumber)
	s, sHits := rpcServer(t, blockNumber)
	c, err := dialRPC(context.Background(), []string{p.URL, s.URL})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.BlockNumber(context.Background()); err != nil {
		t.Fatal(err)
	}
	if pHits.Load() != 1 || sHits.Load() != 0 {
		t.Fatalf("primary hits %d, secondary hits %d", pHits.Load(), sHits.Load())
	}
}

func TestDialRPCLastAnswerStands(t *testing.T) {
	p, _ := rpcServer(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "limited", http.StatusTooManyRequests)
	})
	s, _ := rpcServer(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "limited", http.StatusTooManyRequests)
	})
	c, err := dialRPC(context.Background(), []string{p.URL, s.URL})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.BlockNumber(context.Background()); err == nil {
		t.Fatal("both endpoints refused, yet the call succeeded")
	}
}
