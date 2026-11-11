package alibilog

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"testing"
)

func stopLeaf(body string) []byte { return []byte(StopPrefix + body) }

func TestParseStop(t *testing.T) {
	digest := sha256.Sum256(nil)
	d := base64.RawURLEncoding.EncodeToString(digest[:])
	ok := `{"issued_at":"2026-11-11T09:00:00Z","mandate_count":2,"mandates_digest":"` + d + `","stop_id":"01KA0000000000000000000000"}`
	s, err := ParseStop(stopLeaf(ok))
	if err != nil {
		t.Fatal(err)
	}
	if s.StopID != "01KA0000000000000000000000" || s.MandateCount != 2 || s.MandatesDigest != digest {
		t.Fatalf("parsed %+v", s)
	}

	for name, body := range map[string]string{
		"spaces":    `{"issued_at": "2026-11-11T09:00:00Z","mandate_count":2,"mandates_digest":"` + d + `","stop_id":"01KA0000000000000000000000"}`,
		"order":     `{"mandate_count":2,"issued_at":"2026-11-11T09:00:00Z","mandates_digest":"` + d + `","stop_id":"01KA0000000000000000000000"}`,
		"unknown":   `{"issued_at":"2026-11-11T09:00:00Z","mandate_count":2,"mandates_digest":"` + d + `","stop_id":"01KA0000000000000000000000","user":"x"}`,
		"no count":  `{"issued_at":"2026-11-11T09:00:00Z","mandates_digest":"` + d + `","stop_id":"01KA0000000000000000000000"}`,
		"negative":  `{"issued_at":"2026-11-11T09:00:00Z","mandate_count":-1,"mandates_digest":"` + d + `","stop_id":"01KA0000000000000000000000"}`,
		"bad id":    `{"issued_at":"2026-11-11T09:00:00Z","mandate_count":2,"mandates_digest":"` + d + `","stop_id":"nope"}`,
		"bad time":  `{"issued_at":"2026-11-11T09:00:00.5Z","mandate_count":2,"mandates_digest":"` + d + `","stop_id":"01KA0000000000000000000000"}`,
		"short sum": `{"issued_at":"2026-11-11T09:00:00Z","mandate_count":2,"mandates_digest":"AAAA","stop_id":"01KA0000000000000000000000"}`,
	} {
		var le *LeafError
		if _, err := ParseStop(stopLeaf(body)); !errors.As(err, &le) {
			t.Errorf("%s: admitted (%v)", name, err)
		}
	}
	if _, err := ParseStop([]byte(Prefix + ok)); err == nil {
		t.Error("an alibi prefix parsed as a stop")
	}
	if _, err := Parse(stopLeaf(ok)); err == nil {
		t.Error("a stop leaf parsed as an Alibi")
	}
}

func TestMandatesDigest(t *testing.T) {
	a, b := [32]byte{1}, [32]byte{2}
	want := sha256.Sum256(append(append([]byte{}, a[:]...), b[:]...))
	if MandatesDigest([][32]byte{b, a, b}) != want {
		t.Fatal("the digest is not of the sorted, unique hashes")
	}
}

// TestStopVector parses the leaf `@keelson/log` builds in test/stop.test.ts.
func TestStopVector(t *testing.T) {
	leaf := StopPrefix + `{"issued_at":"2026-11-11T09:00:00Z","mandate_count":2,"mandates_digest":"-Biv03ptw7yS-0RzEBEncAbbTvpukCPNdGjAIzXSKk0","stop_id":"01KA0000000000000000000001"}`
	s, err := ParseStop([]byte(leaf))
	if err != nil {
		t.Fatal(err)
	}
	var a, b [32]byte
	copy(a[:], bytes.Repeat([]byte{1}, 32))
	copy(b[:], bytes.Repeat([]byte{2}, 32))
	if s.MandatesDigest != MandatesDigest([][32]byte{a, b}) {
		t.Fatal("the digest is not the TypeScript builder's")
	}
}
