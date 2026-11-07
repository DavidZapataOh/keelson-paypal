package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"filippo.io/torchwood"
	"github.com/DavidZapataOh/keelson-paypal/internal/alibilog"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/transparency-dev/tessera/client"
	"golang.org/x/mod/sumdb/note"
	"golang.org/x/mod/sumdb/tlog"
)

func publicFetcher(t testing.TB, l *testLog, path string) *client.HTTPFetcher {
	t.Helper()
	u, _ := url.Parse(l.public.URL + "/" + path + "/")
	f, err := client.NewHTTPFetcher(u, http.DefaultClient)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// checkAppended verifies the proof the log returned and reads the entry back
// from the public entry bundle.
func checkAppended(t *testing.T, keys testKeys, l *testLog, leaf []byte, res map[string]string) uint64 {
	t.Helper()
	h := alibilog.LeafHash(leaf)
	if res["leafHash"] != hex.EncodeToString(h[:]) {
		t.Fatalf("leaf hash %s, want %x", res["leafHash"], h)
	}
	origin := host + "/" + sandbox
	if err := torchwood.VerifyProof(keys.policy[origin], tlog.Hash(h), []byte(res["proof"])); err != nil {
		t.Fatalf("proof: %v", err)
	}
	c, _, err := torchwood.VerifyCheckpoint([]byte(res["checkpoint"]), keys.policy[origin])
	if err != nil {
		t.Fatal(err)
	}
	var index uint64
	fmt.Sscan(res["index"], &index)
	if c.N <= int64(index) {
		t.Fatalf("checkpoint size %d does not cover %d", c.N, index)
	}
	f := publicFetcher(t, l, sandbox)
	bundle, err := client.GetEntryBundle(context.Background(), f.ReadEntryBundle, index/256, uint64(c.N))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(bundle.Entries[index%256], leaf) {
		t.Fatal("the entry bundle does not hold the leaf")
	}
	return index
}

func TestAppendsCountersignedLeaves(t *testing.T) {
	vectors, _ := loadVectors(t)
	allow, deny, degraded := vectors["allow"], vectors["deny"], vectors["degraded"]
	db, dbURL := testDB(t)
	keys := newTestKeys(t)
	l := startLog(t, keys, t.TempDir(), db, dbURL)
	activate(t, db, teeTDX, *allow.Signers["tdx"], *allow.Measurements["tdx"])
	activate(t, db, teeNitro, *allow.Signers["nitro"], *allow.Measurements["nitro"])
	purchase(t, db, alibiID(t, allow.Leaf), ptr("2of2"))
	purchase(t, db, alibiID(t, deny.Leaf), ptr("2of2"))
	purchase(t, db, alibiID(t, degraded.Leaf), ptr("degraded"))

	var first []byte
	captured := map[string]any{"vkeys": keys.vkeys[host+"/"+sandbox]}
	for _, v := range []vector{allow, deny} {
		status, res := l.add(t, sandbox, testToken, v.Leaf, v.Countersign)
		if status != http.StatusOK {
			t.Fatalf("%s: %d %v", v.Name, status, res)
		}
		checkAppended(t, keys, l, v.Leaf, res)
		if first == nil {
			first = []byte(res["checkpoint"])
		}
		captured[v.Name] = res
	}

	// Leg B is down: leg A's signer alone countersigned the next purchase.
	activate(t, db, teeTDX, *degraded.Signers["tdx"], *degraded.Measurements["tdx"])
	status, res := l.add(t, sandbox, testToken, degraded.Leaf, degraded.Countersign)
	if status != http.StatusOK {
		t.Fatalf("degraded: %d %v", status, res)
	}
	index := checkAppended(t, keys, l, degraded.Leaf, res)
	captured["degraded"] = res
	// The appends above, for the TypeScript proof verifier. Set LOG_WRITE_VECTORS=1 to refresh.
	if os.Getenv("LOG_WRITE_VECTORS") == "1" {
		out, _ := json.MarshalIndent(captured, "", "  ")
		if err := os.WriteFile("../../packages/log/test/vectors/proofs.json", append(out, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	bundle, err := client.GetEntryBundle(context.Background(), publicFetcher(t, l, sandbox).ReadEntryBundle, 0, index+1)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := alibilog.Parse(bundle.Entries[index])
	if err != nil || !bytes.Contains(bundle.Entries[index], []byte(`"mode":"degraded"`)) || len(entry.TeeSigs) != 1 {
		t.Fatalf("the public entry does not show one degraded signature: %s", bundle.Entries[index])
	}

	// A tlog-tiles client proves the second checkpoint consistent with the first.
	origin := host + "/" + sandbox
	v, err := note.NewVerifier(keys.vkeys[origin][0])
	if err != nil {
		t.Fatal(err)
	}
	f := publicFetcher(t, l, sandbox)
	tracker, err := client.NewLogStateTracker(context.Background(), f.ReadTile, first, v, origin, client.UnilateralConsensus(f.ReadCheckpoint))
	if err != nil {
		t.Fatal(err)
	}
	old, proof, latest, err := tracker.Update(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(old, latest) || len(proof) == 0 {
		t.Fatal("no consistency proof from the first checkpoint to the latest")
	}
}

func TestTheSameLeafGetsOneIndex(t *testing.T) {
	vectors, _ := loadVectors(t)
	allow := vectors["allow"]
	db, dbURL := testDB(t)
	keys := newTestKeys(t)
	dir := t.TempDir()
	activate(t, db, teeTDX, *allow.Signers["tdx"], *allow.Measurements["tdx"])
	activate(t, db, teeNitro, *allow.Signers["nitro"], *allow.Measurements["nitro"])
	purchase(t, db, alibiID(t, allow.Leaf), ptr("2of2"))

	// Each run is a separate process on the same directory, as a restart is.
	run := func(n int) []string {
		cmd := exec.Command(os.Args[0], "-test.run=^TestHelperAppend$")
		cmd.Env = append(os.Environ(), "LOG_HELPER=1", fmt.Sprintf("LOG_HELPER_N=%d", n), "LOG_HELPER_DIR="+dir, "LOG_HELPER_DB="+dbURL)
		for k, v := range keys.env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		var indexes []string
		for _, line := range strings.Split(string(out), "\n") {
			if i, ok := strings.CutPrefix(line, "index="); ok {
				indexes = append(indexes, i)
			}
		}
		return indexes
	}
	concurrent := run(20)
	if len(concurrent) != 20 || len(slices.Compact(slices.Clone(concurrent))) != 1 {
		t.Fatalf("20 concurrent appends gave %v", concurrent)
	}
	again := run(1)
	if len(again) != 1 || again[0] != concurrent[0] {
		t.Fatalf("after a restart the leaf got %v, before %s", again, concurrent[0])
	}
}

// TestHelperAppend is run as a child process by TestTheSameLeafGetsOneIndex.
func TestHelperAppend(t *testing.T) {
	if os.Getenv("LOG_HELPER") != "1" {
		t.Skip("run by TestTheSameLeafGetsOneIndex")
	}
	vectors, _ := loadVectors(t)
	allow := vectors["allow"]
	keys := testKeys{env: map[string]string{}}
	for _, o := range originSpecs {
		for _, k := range []string{"LOG_SIGNER_KEY_", "LOG_MLDSA_SEED_"} {
			keys.env[k+o.Env] = os.Getenv(k + o.Env)
		}
	}
	db, err := pgxpool.New(context.Background(), os.Getenv("LOG_HELPER_DB"))
	if err != nil {
		t.Fatal(err)
	}
	l := startLog(t, keys, os.Getenv("LOG_HELPER_DIR"), db, os.Getenv("LOG_HELPER_DB"))
	var n int
	fmt.Sscan(os.Getenv("LOG_HELPER_N"), &n)
	var wg sync.WaitGroup
	var mu sync.Mutex
	for range n {
		wg.Go(func() {
			status, res := l.add(t, sandbox, testToken, allow.Leaf, allow.Countersign)
			mu.Lock()
			defer mu.Unlock()
			if status != http.StatusOK {
				t.Errorf("%d %v", status, res)
				return
			}
			fmt.Printf("index=%s\n", res["index"])
		})
	}
	wg.Wait()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, o := range l.s.origins {
		if err := o.shutdown(ctx); err != nil {
			t.Fatal(err)
		}
	}
}

func TestTheWritePathIsPrivate(t *testing.T) {
	vectors, _ := loadVectors(t)
	allow := vectors["allow"]
	db, dbURL := testDB(t)
	l := startLog(t, newTestKeys(t), t.TempDir(), db, dbURL)

	body, _ := json.Marshal(map[string]any{"leaf": allow.Leaf, "countersign": allow.Countersign})
	for _, path := range []string{"/" + sandbox + "/add", "/alibi-live/2026-1/add", "/add"} {
		res, err := http.Post(l.public.URL+path, "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("POST %s on the public listener: %d", path, res.StatusCode)
		}
	}
	if res, err := http.Get(l.private.URL + "/" + sandbox + "/checkpoint"); err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("GET checkpoint on the private listener: %v %v", err, res)
	}
	for _, token := range []string{"", "wrong-token", testToken + "x"} {
		if status, _ := l.add(t, sandbox, token, allow.Leaf, allow.Countersign); status != http.StatusUnauthorized {
			t.Fatalf("token %q: %d", token, status)
		}
	}
	for _, path := range []string{"/" + sandbox + "/.state/treeState", "/" + sandbox + "/", "/" + sandbox + "/tile/"} {
		res, err := http.Get(l.public.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("GET %s: %d", path, res.StatusCode)
		}
	}
}

func TestPublicCacheHeaders(t *testing.T) {
	vectors, _ := loadVectors(t)
	allow := vectors["allow"]
	db, dbURL := testDB(t)
	l := startLog(t, newTestKeys(t), t.TempDir(), db, dbURL)
	activate(t, db, teeTDX, *allow.Signers["tdx"], *allow.Measurements["tdx"])
	activate(t, db, teeNitro, *allow.Signers["nitro"], *allow.Measurements["nitro"])
	purchase(t, db, alibiID(t, allow.Leaf), ptr("2of2"))
	if status, res := l.add(t, sandbox, testToken, allow.Leaf, allow.Countersign); status != http.StatusOK {
		t.Fatalf("%d %v", status, res)
	}
	for path, want := range map[string]string{
		"checkpoint":           "no-cache",
		"tile/0/000.p/1":       "public, max-age=31536000, immutable",
		"tile/entries/000.p/1": "public, max-age=31536000, immutable",
		"tile/0/001.p/1":       "no-store",
	} {
		res, err := http.Get(l.public.URL + "/" + sandbox + "/" + path)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if got := res.Header.Get("Cache-Control"); got != want {
			t.Errorf("%s: Cache-Control %q, want %q", path, got, want)
		}
		if res.StatusCode == http.StatusOK && res.Header.Get("Access-Control-Allow-Origin") != "*" {
			t.Errorf("%s: no CORS header", path)
		}
	}
	res, err := http.Get(l.public.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var h struct {
		Origins []struct {
			Origin string `json:"origin"`
			Size   int64  `json:"size"`
		} `json:"origins"`
	}
	if err := json.NewDecoder(res.Body).Decode(&h); err != nil || len(h.Origins) != 2 || h.Origins[0].Size != 1 {
		t.Fatalf("health: %v %+v", err, h)
	}
}
