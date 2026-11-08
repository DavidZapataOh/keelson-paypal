//go:build live

package main

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

const immutable = "public, max-age=31536000, immutable"

var maxAgeRE = regexp.MustCompile(`max-age=(\d+)`)

// TestLiveCheckpointIsNotCachedBeyondSeconds keeps the edge from serving a
// stale view of the log: the checkpoint is revalidated or cached for at most
// two seconds.
func TestLiveCheckpointIsNotCachedBeyondSeconds(t *testing.T) {
	for _, o := range liveOrigins(t) {
		res, _ := get(t, o.base+"checkpoint")
		cc := res.Header.Get("Cache-Control")
		if m := maxAgeRE.FindStringSubmatch(cc); !strings.Contains(cc, "no-cache") && !strings.Contains(cc, "no-store") &&
			(m == nil || atoi(m[1]) > 2) {
			t.Errorf("%s checkpoint: Cache-Control %q", o.spec.Name, cc)
		}
		if s, age := res.Header.Get("Cf-Cache-Status"), atoi(res.Header.Get("Age")); s == "HIT" && age > 2 {
			t.Errorf("%s checkpoint: served from the edge %d s old", o.spec.Name, age)
		}
	}
}

// TestLiveTilesAreImmutable checks c2sp.org/tlog-tiles caching: full and
// partial hash tiles and entry bundles never change once served.
func TestLiveTilesAreImmutable(t *testing.T) {
	for _, o := range liveOrigins(t) {
		c := liveCheckpoint(t, o)
		if c.N == 0 {
			t.Logf("%s is empty", o.spec.Name)
			continue
		}
		var paths []string
		if c.N >= 256 {
			paths = append(paths, "tile/0/000", "tile/entries/000")
		}
		if w := c.N % 256; w != 0 {
			n := tileIndex(c.N / 256)
			paths = append(paths, "tile/0/"+n+".p/"+strconv.Itoa(int(w)), "tile/entries/"+n+".p/"+strconv.Itoa(int(w)))
		}
		for _, p := range paths {
			res, _ := get(t, o.base+p)
			if res.StatusCode != http.StatusOK {
				t.Errorf("%s %s: %d", o.spec.Name, p, res.StatusCode)
				continue
			}
			if cc := res.Header.Get("Cache-Control"); cc != immutable {
				t.Errorf("%s %s: Cache-Control %q", o.spec.Name, p, cc)
			}
		}
	}
}

func TestLiveWritePathIsNotServed(t *testing.T) {
	for _, o := range liveOrigins(t) {
		res, _ := get(t, o.base+"add")
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("GET %sadd: %d", o.base, res.StatusCode)
		}
	}
}

// tileIndex is the c2sp.org/tlog-tiles path element of tile index n.
func tileIndex(n int64) string {
	s := strconv.FormatInt(n%1000, 10)
	s = strings.Repeat("0", 3-len(s)) + s
	for n /= 1000; n > 0; n /= 1000 {
		e := strconv.FormatInt(n%1000, 10)
		s = "x" + strings.Repeat("0", 3-len(e)) + e + "/" + s
	}
	return s
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
