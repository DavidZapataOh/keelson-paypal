package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"filippo.io/torchwood"
	"github.com/transparency-dev/merkle/proof"
	"github.com/transparency-dev/merkle/rfc6962"
	"github.com/transparency-dev/tessera/client"
)

// consistency asks the private listener for a consistency proof.
func (l *testLog) consistency(t testing.TB, path, token, from, to string) (int, [][]byte) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, l.private.URL+"/"+path+"/consistency?from="+from+"&to="+to, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out struct {
		From  string   `json:"from"`
		To    string   `json:"to"`
		Proof [][]byte `json:"proof"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	if res.StatusCode == http.StatusOK && (out.From != from || out.To != to) {
		t.Fatalf("the proof is for %s..%s, asked %s..%s", out.From, out.To, from, to)
	}
	return res.StatusCode, out.Proof
}

func TestConsistencyProofs(t *testing.T) {
	vectors, _ := loadVectors(t)
	allow, deny, degraded := vectors["allow"], vectors["deny"], vectors["degraded"]
	db, dbURL := testDB(t)
	keys := newTestKeys(t)
	l := startLog(t, keys, logDir(t), db, dbURL)
	activate(t, db, teeTDX, *allow.Signers["tdx"], *allow.Measurements["tdx"])
	activate(t, db, teeNitro, *allow.Signers["nitro"], *allow.Measurements["nitro"])
	origin := host + "/" + sandbox
	roots := map[int64][]byte{}
	for _, v := range []vector{allow, deny, degraded} {
		purchase(t, db, alibiID(t, v.Leaf), ptr(v.Mode))
		if v.Name == "degraded" {
			activate(t, db, teeTDX, *v.Signers["tdx"], *v.Measurements["tdx"])
		}
		status, res := l.add(t, sandbox, testToken, v.Leaf, v.Countersign)
		if status != http.StatusOK {
			t.Fatalf("%s: %d %v", v.Name, status, res)
		}
		c, _, err := torchwood.VerifyCheckpoint([]byte(res["checkpoint"]), keys.policy[origin])
		if err != nil {
			t.Fatal(err)
		}
		roots[c.N] = c.Hash[:]
	}
	size := int64(3)
	if roots[size] == nil {
		t.Fatalf("no checkpoint covers the three leaves: %v", roots)
	}

	pb, err := client.NewProofBuilder(context.Background(), uint64(size), publicFetcher(t, l, sandbox).ReadTile)
	if err != nil {
		t.Fatal(err)
	}
	for m := int64(1); m <= size; m++ {
		for n := m; n <= size; n++ {
			if roots[m] == nil || roots[n] == nil {
				continue
			}
			status, got := l.consistency(t, sandbox, testToken, fmt.Sprint(m), fmt.Sprint(n))
			if status != http.StatusOK {
				t.Fatalf("%d..%d: %d", m, n, status)
			}
			want, err := pb.ConsistencyProof(context.Background(), uint64(m), uint64(n))
			if err != nil {
				t.Fatal(err)
			}
			if fmt.Sprint(got) != fmt.Sprint(want) {
				t.Fatalf("%d..%d: the route's proof is not the proof builder's", m, n)
			}
			if err := proof.VerifyConsistency(rfc6962.DefaultHasher, uint64(m), uint64(n), got, roots[m], roots[n]); err != nil {
				t.Fatalf("%d..%d: %v", m, n, err)
			}
		}
	}

	for _, q := range [][2]string{{"0", "1"}, {"2", "1"}, {"1", fmt.Sprint(size + 1)}, {"x", "1"}} {
		if status, _ := l.consistency(t, sandbox, testToken, q[0], q[1]); status != http.StatusBadRequest {
			t.Fatalf("%s..%s: %d, want 400", q[0], q[1], status)
		}
	}
	if status, _ := l.consistency(t, sandbox, "", "1", "1"); status != http.StatusUnauthorized {
		t.Fatalf("without the bearer: %d, want 401", status)
	}
}
