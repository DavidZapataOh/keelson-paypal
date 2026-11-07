//go:build live

package main

import (
	"cmp"
	"context"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"filippo.io/torchwood"
	"github.com/transparency-dev/merkle/proof"
	"github.com/transparency-dev/merkle/rfc6962"
	"github.com/transparency-dev/tessera/client"
	"golang.org/x/mod/sumdb/note"
	"golang.org/x/mod/sumdb/tlog"
)

var liveURL = strings.TrimSuffix(cmp.Or(os.Getenv("LOG_URL"), "https://"+host), "/")

type liveOrigin struct {
	spec   originSpec
	policy torchwood.Policy
	ed     note.Verifier
	base   string
}

func liveOrigins(t *testing.T) []liveOrigin {
	t.Helper()
	var out []liveOrigin
	for _, o := range originSpecs {
		name := strings.ReplaceAll(o.path(), "/", "-")
		ed, err := os.ReadFile("keys/" + name + ".vkey")
		if err != nil {
			t.Fatal(err)
		}
		ml, err := os.ReadFile("keys/" + name + ".mldsa.vkey")
		if err != nil {
			t.Fatal(err)
		}
		p, err := torchwood.ParsePolicy([]byte("log " + string(ed) + "log " + string(ml) + "quorum none\n"))
		if err != nil {
			t.Fatal(err)
		}
		v, err := note.NewVerifier(strings.TrimSpace(string(ed)))
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, liveOrigin{o, p, v, liveURL + "/" + o.path() + "/"})
	}
	return out
}

func get(t *testing.T, url string) (*http.Response, []byte) {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res, body
}

func liveCheckpoint(t *testing.T, o liveOrigin) torchwood.Checkpoint {
	t.Helper()
	res, body := get(t, o.base+"checkpoint")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("%s checkpoint: %d", o.spec.Name, res.StatusCode)
	}
	c, _, err := torchwood.VerifyCheckpoint(body, o.policy)
	if err != nil {
		t.Fatalf("%s checkpoint: %v", o.spec.Name, err)
	}
	return c
}

func TestLiveCheckpointsCarryBothSignatures(t *testing.T) {
	for _, o := range liveOrigins(t) {
		c := liveCheckpoint(t, o)
		t.Logf("%s: size %d", o.spec.Name, c.N)
	}
}

func TestLiveWritePathIsNotPublic(t *testing.T) {
	for _, o := range liveOrigins(t) {
		res, err := http.Post(o.base+"add", "application/json", strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("POST %sadd: %d", o.base, res.StatusCode)
		}
	}
}

// TestLiveTwoClientsAgree proves every entry's inclusion and the tree's
// consistency with Tessera's client and, independently, with torchwood's.
func TestLiveTwoClientsAgree(t *testing.T) {
	ctx := context.Background()
	for _, o := range liveOrigins(t) {
		c := liveCheckpoint(t, o)
		if c.N == 0 {
			t.Logf("%s is empty", o.spec.Name)
			continue
		}
		fetcher, err := client.NewHTTPFetcher(mustURL(o.base), nil)
		if err != nil {
			t.Fatal(err)
		}
		tracker, err := client.NewLogStateTracker(ctx, fetcher.ReadTile, nil, o.ed, o.spec.Name, client.UnilateralConsensus(fetcher.ReadCheckpoint))
		if err != nil {
			t.Fatal(err)
		}
		tess := tracker.Latest()
		pb, err := client.NewProofBuilder(ctx, tess.Size, fetcher.ReadTile)
		if err != nil {
			t.Fatal(err)
		}

		tf, err := torchwood.NewTileFetcher(o.base)
		if err != nil {
			t.Fatal(err)
		}
		tree := tlog.Tree{N: int64(tess.Size), Hash: tlog.Hash(tess.Hash)}
		hr := torchwood.TileHashReaderWithContext(ctx, tree, tf)
		tc, err := torchwood.NewClient(tf)
		if err != nil {
			t.Fatal(err)
		}

		for i := range int64(tess.Size) {
			entry, rp, err := tc.Entry(ctx, tree, i)
			if err != nil {
				t.Fatalf("torchwood entry %d: %v", i, err)
			}
			if err := tlog.CheckRecord(rp, tree.N, tree.Hash, i, tlog.RecordHash(entry)); err != nil {
				t.Fatalf("torchwood inclusion %d: %v", i, err)
			}
			ip, err := pb.InclusionProof(ctx, uint64(i))
			if err != nil {
				t.Fatal(err)
			}
			lh := rfc6962.DefaultHasher.HashLeaf(entry)
			if err := proof.VerifyInclusion(rfc6962.DefaultHasher, uint64(i), tess.Size, lh, ip, tess.Hash); err != nil {
				t.Fatalf("tessera inclusion %d: %v", i, err)
			}
		}

		if tess.Size > 1 {
			m := tess.Size / 2
			oldRoot, err := tlog.TreeHash(int64(m), hr)
			if err != nil {
				t.Fatal(err)
			}
			cp, err := pb.ConsistencyProof(ctx, m, tess.Size)
			if err != nil {
				t.Fatal(err)
			}
			if err := proof.VerifyConsistency(rfc6962.DefaultHasher, m, tess.Size, cp, oldRoot[:], tess.Hash); err != nil {
				t.Fatalf("tessera consistency %d -> %d: %v", m, tess.Size, err)
			}
			tp, err := tlog.ProveTree(tree.N, int64(m), hr)
			if err != nil {
				t.Fatal(err)
			}
			if err := tlog.CheckTree(tp, tree.N, tree.Hash, int64(m), oldRoot); err != nil {
				t.Fatalf("torchwood consistency %d -> %d: %v", m, tess.Size, err)
			}
		}
		t.Logf("%s: %d entries proven by both clients", o.spec.Name, tess.Size)
	}
}

func TestLiveTilesAreServedFromTheEdge(t *testing.T) {
	o := liveOrigins(t)[0]
	c := liveCheckpoint(t, o)
	if c.N == 0 {
		t.Skip("the log is empty")
	}
	path := "tile/0/000"
	if c.N < 256 {
		path += ".p/" + strconv.Itoa(int(c.N))
	}
	get(t, o.base+path)
	var times []time.Duration
	for range 20 {
		t0 := time.Now()
		res, _ := get(t, o.base+path)
		times = append(times, time.Since(t0))
		if res.StatusCode != http.StatusOK {
			t.Fatalf("%s: %d", path, res.StatusCode)
		}
		if s := res.Header.Get("Cf-Cache-Status"); s != "HIT" {
			t.Fatalf("%s: cf-cache-status %q", path, s)
		}
	}
	t.Logf("%s from the edge: p95 %v", path, percentile(times, .95))
}

func mustURL(s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		panic(err)
	}
	return u
}
