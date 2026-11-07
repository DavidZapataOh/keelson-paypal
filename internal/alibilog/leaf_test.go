package alibilog

import (
	"encoding/hex"
	"errors"
	"testing"
)

func TestParseAcceptsEveryPositiveVector(t *testing.T) {
	pos, _ := loadVectors(t)
	for _, v := range pos {
		t.Run(v.Name, func(t *testing.T) {
			leaf := decode(t, v.Leaf)
			l, err := Parse(leaf)
			if err != nil {
				t.Fatal(err)
			}
			if l.Mode != v.Mode {
				t.Fatalf("mode %q, want %q", l.Mode, v.Mode)
			}
			want := 2
			if v.Mode == ModeDegraded {
				want = 1
			}
			if len(l.TeeSigs) != want || len(l.Measurements) != want {
				t.Fatalf("%d signatures and %d measurements", len(l.TeeSigs), len(l.Measurements))
			}
			h := LeafHash(leaf)
			if hex.EncodeToString(h[:]) != v.LeafHash {
				t.Fatalf("leaf hash %x, want %s", h, v.LeafHash)
			}
			t.Logf("%s: %d bytes", v.Name, len(leaf))
		})
	}
}

func TestParseRejectsEveryNegativeVector(t *testing.T) {
	_, neg := loadVectors(t)
	for _, v := range neg {
		t.Run(v.Name, func(t *testing.T) {
			_, err := Parse(decode(t, v.Leaf))
			var le *LeafError
			if !errors.As(err, &le) {
				t.Fatalf("got %v, want a *LeafError", err)
			}
			if le.Code != v.Code {
				t.Fatalf("code %q, want %q", le.Code, v.Code)
			}
		})
	}
}

func TestParseRejectsNonCanonicalForms(t *testing.T) {
	pos, _ := loadVectors(t)
	leaf := decode(t, pos[0].Leaf)
	cases := map[string][]byte{
		"trailing newline": append(append([]byte{}, leaf...), '\n'),
		"escaped digit":    replaceOnce(leaf, `"mode":"2of2"`, `"mode":"2of\u0032"`),
		"duplicate key":    replaceOnce(leaf, `"mode":"2of2"`, `"mode":"2of2","mode":"2of2"`),
		"uppercase key":    replaceOnce(leaf, `"mode"`, `"MODE"`),
		"numeric agent id": replaceOnce(leaf, `"agent_id":"42"`, `"agent_id":42`),
		"leading zero":     replaceOnce(leaf, `"agent_id":"42"`, `"agent_id":"042"`),
	}
	for name, b := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(b); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}

func replaceOnce(b []byte, old, new string) []byte {
	s := string(b)
	for i := 0; i+len(old) <= len(s); i++ {
		if s[i:i+len(old)] == old {
			return []byte(s[:i] + new + s[i+len(old):])
		}
	}
	panic("not found: " + old)
}
