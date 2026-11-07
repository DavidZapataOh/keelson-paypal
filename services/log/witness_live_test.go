//go:build live

package main

import (
	"cmp"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"filippo.io/torchwood"
	"github.com/DavidZapataOh/keelson-paypal/internal/conformance"
	"golang.org/x/mod/sumdb/note"
)

var liveWitnesses = []string{
	"https://witness-1.keelson.finance",
	"https://witness-2.keelson.finance",
	"https://witness-3.keelson.finance",
}

func getBody(t *testing.T, url string) []byte {
	t.Helper()
	c := &http.Client{Timeout: 10 * time.Second}
	res, err := c.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("%s: %d %s", url, res.StatusCode, body)
	}
	return body
}

// TestLiveCheckpointsAreWitnessed requires the latest checkpoint of every origin
// to satisfy the committed policy, which the log also publishes.
func TestLiveCheckpointsAreWitnessed(t *testing.T) {
	base := cmp.Or(os.Getenv("LOG_URL"), "https://"+host)
	for _, o := range originSpecs {
		policy, err := os.ReadFile("policy/" + o.policyFile())
		if err != nil {
			t.Fatal(err)
		}
		if published := getBody(t, base+"/"+o.path()+"/policy"); string(published) != string(policy) {
			t.Fatalf("%s: the published policy differs from policy/%s", o.Name, o.policyFile())
		}
		p, err := torchwood.ParsePolicy(policy)
		if err != nil {
			t.Fatal(err)
		}
		cp := getBody(t, base+"/"+o.path()+"/checkpoint")
		if _, _, err := torchwood.VerifyCheckpoint(cp, p); err != nil {
			t.Fatalf("%s: %v\n%s", o.Name, err, cp)
		}
	}
}

// TestLiveWitnessesKnowTheLogs checks that every witness serves its status page
// with the three origins it cosigns.
func TestLiveWitnessesKnowTheLogs(t *testing.T) {
	logs, err := os.ReadFile("../witness/logs")
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range liveWitnesses {
		index := string(getBody(t, w+"/"))
		for _, line := range strings.Fields(string(logs)) {
			origin, _, _ := strings.Cut(line, "=")
			if !strings.Contains(index, origin) {
				t.Errorf("%s does not list %s", w, origin)
			}
		}
	}
}

func conformanceSigner(t *testing.T) note.Signer {
	t.Helper()
	skey := os.Getenv("LOG_SIGNER_KEY_CONFORMANCE")
	if skey == "" {
		t.Fatal("LOG_SIGNER_KEY_CONFORMANCE is required")
	}
	s, err := note.NewSigner(skey)
	if err != nil || s.Name() != conformance.Origin {
		t.Fatalf("LOG_SIGNER_KEY_CONFORMANCE is not a key for %s", conformance.Origin)
	}
	return s
}

// TestLiveWitnessesRefuseForks grows the conformance log by one entry at each
// witness and requires it to refuse a fork at that size (422) and a rollback (409).
func TestLiveWitnessesRefuseForks(t *testing.T) {
	s := conformanceSigner(t)
	for _, w := range liveWitnesses {
		n := checkRefusesForks(t, w, s)
		t.Logf("%s cosigned %s at size %d", w, conformance.Origin, n)
	}
}

// TestLiveWitnessesRemember checks, across a redeploy, that each witness still
// knows the conformance log at the size it knew before and refuses a fork there.
// WITNESS_SIZES_OUT records the sizes; WITNESS_SIZES_IN requires them.
func TestLiveWitnessesRemember(t *testing.T) {
	s := conformanceSigner(t)
	sizes := map[string]uint64{}
	for _, w := range liveWitnesses {
		sizes[w] = knownSize(t, w, s)
	}
	if out := os.Getenv("WITNESS_SIZES_OUT"); out != "" {
		raw, _ := json.Marshal(sizes)
		if err := os.WriteFile(out, raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if in := os.Getenv("WITNESS_SIZES_IN"); in != "" {
		raw, err := os.ReadFile(in)
		if err != nil {
			t.Fatal(err)
		}
		var before map[string]uint64
		if err := json.Unmarshal(raw, &before); err != nil {
			t.Fatal(err)
		}
		for w, n := range before {
			if sizes[w] != n {
				t.Errorf("%s knew size %d before the redeploy and %d after", w, n, sizes[w])
			}
		}
	}
	for w, n := range sizes {
		if n == 0 {
			t.Errorf("%s has never cosigned the conformance log", w)
			continue
		}
		checkRefusesFork(t, w, s, n)
	}
}
