//go:build live

package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/DavidZapataOh/keelson-paypal/internal/conformance"
	"golang.org/x/mod/sumdb/note"
)

// TestLiveFollowerVerifiesTheLogs follows the production origins with the
// pinned policies and checks the co-logged checkpoints in Sigsum.
func TestLiveFollowerVerifiesTheLogs(t *testing.T) {
	cfg, err := loadConfig(func(k string) string {
		if k == "MONITOR_DATA_DIR" {
			return t.TempDir()
		}
		return os.Getenv(k)
	})
	if err != nil {
		t.Fatal(err)
	}
	st, err := openState(cfg.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	start := time.Now()
	for _, o := range cfg.Origins {
		go Follow(ctx, o, st, cfg.Poll, cfg.Sigsum, &http.Client{Timeout: 10 * time.Second}, make(chan Event, 64), slog.Default())
	}
	deadline := time.Now().Add(60 * time.Second)
	for _, o := range cfg.Origins {
		for {
			r := buildReport(o, st)
			if !r.VerifiedAt.IsZero() && r.LeavesAudited == r.Size && (o.Name != cfg.Origins[0].Name || r.CoLogged != nil) {
				t.Logf("%s: size %d, %d leaves audited, cosigned by %v, co-logged %+v, degraded %v, findings %v in %v",
					o.Name, r.Size, r.LeavesAudited, r.Cosigners, r.CoLogged, r.DegradedLeaves, r.Findings, time.Since(start))
				if len(r.Cosigners) < 2 || len(r.Findings) != 0 {
					t.Fatalf("%s: %+v", o.Name, r)
				}
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s: %+v", o.Name, r)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
}

// TestLiveMonitorReport requires the deployed monitor to have verified both
// origins within the last three seconds, with the witness quorum.
func TestLiveMonitorReport(t *testing.T) {
	base := strings.TrimSuffix(os.Getenv("MONITOR_URL"), "/")
	if base == "" {
		t.Fatal("MONITOR_URL is required")
	}
	// A deploy that just finished may still be starting.
	deadline := time.Now().Add(3 * time.Minute)
	for {
		var r FullReport
		res, err := http.Get(base + "/report")
		if err == nil {
			err = json.NewDecoder(res.Body).Decode(&r)
			res.Body.Close()
		}
		fresh := err == nil && len(r.Origins) == 2
		for _, o := range r.Origins {
			fresh = fresh && time.Since(o.VerifiedAt) < 3*time.Second && len(o.Cosigners) >= 2 && o.LeavesAudited == o.Size && o.Error == ""
		}
		if fresh {
			for _, o := range r.Origins {
				t.Logf("%s: size %d verified %v ago, cosigned by %v, co-logged %+v", o.Origin, o.Size, time.Since(o.VerifiedAt), o.Cosigners, o.CoLogged)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("report: %+v %v", r, err)
		}
		time.Sleep(time.Second)
	}
}

// TestLiveDrill gossips two conflicting conformance checkpoints of one size
// to the deployed monitor and requires it to publish the equivocation within
// one second.
func TestLiveDrill(t *testing.T) {
	base := strings.TrimSuffix(os.Getenv("MONITOR_URL"), "/")
	skey := os.Getenv("LOG_SIGNER_KEY_CONFORMANCE")
	if base == "" || skey == "" {
		t.Fatal("MONITOR_URL and LOG_SIGNER_KEY_CONFORMANCE are required")
	}
	s, err := note.NewSigner(skey)
	if err != nil {
		t.Fatal(err)
	}
	// A size no earlier drill used.
	n := uint64(time.Now().UnixNano())
	root := func(side string) [32]byte { return sha256.Sum256(fmt.Appendf(nil, "drill %d %s", n, side)) }
	gossip := func(cp []byte) (int, map[string]string) {
		res, err := http.Post(base+"/gossip", "text/plain", strings.NewReader(string(cp)))
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		out := map[string]string{}
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	if status, out := gossip(conformance.SignedCheckpoint(s, n, root("a"))); status != 200 {
		t.Fatalf("first checkpoint: %d %v", status, out)
	}
	t0 := time.Now()
	status, out := gossip(conformance.SignedCheckpoint(s, n, root("b")))
	if status != 409 || out["equivocation"] == "" {
		t.Fatalf("conflicting checkpoint: %d %v", status, out)
	}
	for {
		var list []EquivocationSummary
		res, err := http.Get(base + "/equivocations")
		if err != nil {
			t.Fatal(err)
		}
		err = json.NewDecoder(res.Body).Decode(&list)
		res.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range list {
			if e.ID == out["equivocation"] && e.Origin == conformance.Origin {
				d := time.Since(t0)
				t.Logf("equivocation %s listed %v after the second checkpoint was posted", e.ID, d)
				if d >= time.Second {
					t.Fatalf("listed after %v, budget 1s", d)
				}
				return
			}
		}
		if time.Since(t0) > 5*time.Second {
			t.Fatalf("equivocation %s not listed", out["equivocation"])
		}
		time.Sleep(20 * time.Millisecond)
	}
}
