package conformance

import (
	"crypto/rand"
	"testing"

	"filippo.io/torchwood"
	"github.com/transparency-dev/merkle/compact"
	"github.com/transparency-dev/merkle/proof"
	"github.com/transparency-dev/merkle/rfc6962"
	"golang.org/x/mod/sumdb/note"
)

// TestTreeMatchesAnIndependentImplementation checks roots and consistency
// proofs against transparency-dev/merkle.
func TestTreeMatchesAnIndependentImplementation(t *testing.T) {
	rf := compact.RangeFactory{Hash: rfc6962.DefaultHasher.HashChildren}
	r := rf.NewEmptyRange(0)
	roots := map[uint64][]byte{}
	for n := uint64(1); n <= 70; n++ {
		if err := r.Append(rfc6962.DefaultHasher.HashLeaf(Entry(n-1)), nil); err != nil {
			t.Fatal(err)
		}
		want, err := r.GetRootHash(nil)
		if err != nil {
			t.Fatal(err)
		}
		if got := Tree(n); string(got[:]) != string(want) {
			t.Fatalf("size %d: root %x, want %x", n, got, want)
		}
		roots[n] = want
	}
	for m := uint64(1); m <= 70; m++ {
		for _, n := range []uint64{m, m + 1, 70} {
			if n > 70 {
				continue
			}
			if err := proof.VerifyConsistency(rfc6962.DefaultHasher, m, n, Consistency(m, n), roots[m], roots[n]); err != nil {
				t.Fatalf("%d → %d: %v", m, n, err)
			}
		}
	}
}

func TestSignedCheckpointVerifies(t *testing.T) {
	skey, vkey, err := note.GenerateKey(rand.Reader, Origin)
	if err != nil {
		t.Fatal(err)
	}
	s, _ := note.NewSigner(skey)
	policy, err := torchwood.ParsePolicy([]byte("log " + vkey + "\nquorum none\n"))
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := torchwood.VerifyCheckpoint(SignedCheckpoint(s, 5, Tree(5)), policy)
	if err != nil {
		t.Fatal(err)
	}
	if c.Origin != Origin || c.N != 5 || c.Hash != Tree(5) {
		t.Fatalf("%+v", c)
	}
}
