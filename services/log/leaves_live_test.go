//go:build live

package main

import (
	"cmp"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"filippo.io/torchwood"
	"github.com/DavidZapataOh/keelson-paypal/internal/alibilog"
	"golang.org/x/mod/sumdb/tlog"
)

var monitorURL = cmp.Or(os.Getenv("MONITOR_URL"), "https://keelson-monitor-production.up.railway.app")

// TestLivePublicLeavesHoldOnlyTheAlibiFields reads every public entry of each
// origin and parses it with the closed leaf schema, which refuses any other
// key, any value outside its format and a mode that does not match the
// signature count. The degraded leaves found are the ones the monitor lists.
func TestLivePublicLeavesHoldOnlyTheAlibiFields(t *testing.T) {
	ctx := context.Background()
	degraded := monitorDegraded(t)
	for _, o := range liveOrigins(t) {
		c := liveCheckpoint(t, o)
		tf, err := torchwood.NewTileFetcher(o.base)
		if err != nil {
			t.Fatal(err)
		}
		tc, err := torchwood.NewClient(tf)
		if err != nil {
			t.Fatal(err)
		}
		tree := tlog.Tree{N: c.N, Hash: c.Hash}
		n, largest := 0, 0
		for i, entry := range tc.Entries(ctx, tree, 0) {
			l, err := alibilog.Parse(entry)
			if err != nil {
				t.Errorf("%s entry %d: %v", o.spec.Name, i, err)
				continue
			}
			if l.Mode == alibilog.ModeDegraded {
				n++
			}
			largest = max(largest, len(entry))
		}
		if err := tc.Err(); err != nil {
			t.Fatalf("%s: %v", o.spec.Name, err)
		}
		if want, ok := degraded[o.spec.Name]; !ok || want != n {
			t.Errorf("%s: %d degraded leaves in the tiles, the monitor counts %d (listed: %v)", o.spec.Name, n, want, ok)
		}
		t.Logf("%s: %d leaves, %d degraded, largest %d bytes", o.spec.Name, c.N, n, largest)
	}
}

// monitorDegraded is the degraded count of each origin in the monitor's report.
func monitorDegraded(t *testing.T) map[string]int {
	t.Helper()
	res, body := get(t, monitorURL+"/report")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("monitor report: %d", res.StatusCode)
	}
	var r struct {
		Origins []struct {
			Origin        string `json:"origin"`
			DegradedCount int    `json:"degradedCount"`
		} `json:"origins"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		t.Fatal(err)
	}
	out := map[string]int{}
	for _, o := range r.Origins {
		out[o.Origin] = o.DegradedCount
	}
	return out
}
