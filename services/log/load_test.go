package main

import (
	"context"
	"encoding/base64"
	"net/http"
	"os"
	"slices"
	"sync"
	"testing"
	"time"
)

func percentile(d []time.Duration, p float64) time.Duration {
	s := slices.Clone(d)
	slices.Sort(s)
	return s[min(len(s)-1, int(float64(len(s))*p))]
}

// TestLoad appends 1,000 distinct admitted leaves at 100 per second and reports
// the append round trip. The leaves are the real ALLOW countersign with distinct
// PayPal reference commitments, which the countersign does not bind.
func TestLoad(t *testing.T) {
	if os.Getenv("LOG_LOAD") != "1" {
		t.Skip("set LOG_LOAD=1")
	}
	vectors, _ := loadVectors(t)
	allow := vectors["allow"]
	db, dbURL := testDB(t)
	l := startLog(t, newTestKeys(t), t.TempDir(), db, dbURL)
	activate(t, db, teeTDX, *allow.Signers["tdx"], *allow.Measurements["tdx"])
	activate(t, db, teeNitro, *allow.Signers["nitro"], *allow.Measurements["nitro"])
	purchase(t, db, alibiID(t, allow.Leaf), ptr("2of2"))

	const n, rate = 1000, 100
	leaves := make([][]byte, n)
	for i := range leaves {
		leaves[i] = rewrite(t, allow.Leaf, func(m map[string]any) {
			m["paypal_ref_commit"] = base64.RawURLEncoding.EncodeToString(randBytes(32))
		})
	}
	lat := make([]time.Duration, n)
	codes := make([]int, n)
	var wg sync.WaitGroup
	tick := time.NewTicker(time.Second / rate)
	defer tick.Stop()
	started := time.Now()
	for i := range n {
		<-tick.C
		wg.Go(func() {
			t0 := time.Now()
			codes[i], _ = l.add(t, sandbox, testToken, leaves[i], allow.Countersign)
			lat[i] = time.Since(t0)
		})
	}
	wg.Wait()
	elapsed := time.Since(started)
	for i, c := range codes {
		if c != http.StatusOK {
			t.Fatalf("append %d: %d", i, c)
		}
	}
	t.Logf("%d appends in %v (%.0f/s): p50 %v, p95 %v, p99 %v", n, elapsed.Round(time.Millisecond),
		float64(n)/elapsed.Seconds(), percentile(lat, .5), percentile(lat, .95), percentile(lat, .99))

	// Admission alone: parse, digest, two recoveries and three registry reads.
	o := l.origin(sandbox)
	adm := make([]time.Duration, 2000)
	for i := range adm {
		t0 := time.Now()
		if err := o.admit(context.Background(), l.s.registry, leaves[i%n], allow.Countersign); err != nil {
			t.Fatal(err)
		}
		adm[i] = time.Since(t0)
	}
	t.Logf("admission: p50 %v, p99 %v", percentile(adm, .5), percentile(adm, .99))
}
