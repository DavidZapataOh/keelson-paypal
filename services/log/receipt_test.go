package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"github.com/transparency-dev/merkle/proof"
	"github.com/transparency-dev/merkle/rfc6962"
	cose "github.com/veraison/go-cose"
)

type receiptVector struct {
	Origin       string   `json:"origin"`
	SecretKeyHex string   `json:"secret_key_hex"`
	PublicKeyHex string   `json:"public_key_hex"`
	KidHex       string   `json:"kid_hex"`
	EntriesHex   []string `json:"entries_hex"`
	RootHex      string   `json:"root_hex"`
	ProtectedHex string   `json:"protected_hex"`
	ReceiptsHex  []string `json:"receipts_hex"`
}

func loadReceiptVector(t *testing.T) receiptVector {
	t.Helper()
	raw, err := os.ReadFile("../../internal/scitt/testdata/receipt.json")
	if err != nil {
		t.Fatal(err)
	}
	var v receiptVector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// TestReceiptsMatchTheTypeScriptOnes builds, in Go, the receipts the TypeScript code signed for the
// same tree and key, byte for byte.
func TestReceiptsMatchTheTypeScriptOnes(t *testing.T) {
	v := loadReceiptVector(t)
	seed := mustHex(t, v.SecretKeyHex)
	key := ed25519.NewKeyFromSeed(seed)
	if hex.EncodeToString(key.Public().(ed25519.PublicKey)) != v.PublicKeyHex {
		t.Fatal("the vector key is not the seed's")
	}
	if got := hex.EncodeToString(receiptProtected(v.Origin, key.Public().(ed25519.PublicKey))); got != v.ProtectedHex {
		t.Fatalf("protected %s, want %s", got, v.ProtectedHex)
	}
	n := uint64(len(v.EntriesHex))
	hashes := make([][]byte, n)
	for i, e := range v.EntriesHex {
		hashes[i] = rfc6962.DefaultHasher.HashLeaf(mustHex(t, e))
	}
	root := mustHex(t, v.RootHex)
	sig := signReceiptRoot(key, v.Origin, [32]byte(root))
	for i := range n {
		path := inclusionPath(t, hashes, i)
		got, err := buildReceipt(v.Origin, key.Public().(ed25519.PublicKey), sig, n, i, path)
		if err != nil {
			t.Fatal(err)
		}
		if hex.EncodeToString(got) != v.ReceiptsHex[i] {
			t.Fatalf("receipt %d differs from the TypeScript one", i)
		}
		var msg cose.Sign1Message
		if err := msg.UnmarshalCBOR(got); err != nil {
			t.Fatal(err)
		}
		r, err := proof.RootFromInclusionProof(rfc6962.DefaultHasher, i, n, hashes[i], path)
		if err != nil {
			t.Fatal(err)
		}
		msg.Payload = r
		if err := msg.Verify(nil, ed25519Verifier(key.Public().(ed25519.PublicKey))); err != nil {
			t.Fatalf("receipt %d: go-cose verify: %v", i, err)
		}
	}
}

// inclusionPath is the RFC 6962 path of leaf i, computed independently of the log.
func inclusionPath(t *testing.T, hashes [][]byte, i uint64) [][]byte {
	t.Helper()
	var path func(m uint64, hs [][]byte) [][]byte
	mth := func(hs [][]byte) []byte {
		var f func(hs [][]byte) []byte
		f = func(hs [][]byte) []byte {
			if len(hs) == 1 {
				return hs[0]
			}
			k := 1
			for k*2 < len(hs) {
				k *= 2
			}
			return rfc6962.DefaultHasher.HashChildren(f(hs[:k]), f(hs[k:]))
		}
		return f(hs)
	}
	path = func(m uint64, hs [][]byte) [][]byte {
		if len(hs) == 1 {
			return nil
		}
		k := uint64(1)
		for k*2 < uint64(len(hs)) {
			k *= 2
		}
		if m < k {
			return append(path(m, hs[:k]), mth(hs[k:]))
		}
		return append(path(m-k, hs[k:]), mth(hs[:k]))
	}
	return path(i, hashes)
}

func TestRemoteReceiptsKeepOnlyVerifiedRootSignatures(t *testing.T) {
	const origin = "log.keelson.finance/alibi/2026-1"
	priv := ed25519.NewKeyFromSeed(randBytes(32))
	r := newRemoteReceipts(priv.Public().(ed25519.PublicKey))
	root := [32]byte{1}
	other := [32]byte{2}
	sig := signReceiptRoot(priv, origin, root)
	if r.accept(origin, 7, other, sig) {
		t.Fatal("accepted a signature over another root")
	}
	if !r.accept(origin, 7, root, sig) {
		t.Fatal("refused leg A's signature")
	}
	if got := r.rootSignature(origin, 7, root); string(got) != string(sig) {
		t.Fatal("lost the signature of size 7")
	}
	if r.rootSignature(origin, 7, other) != nil || r.rootSignature(origin, 8, root) != nil {
		t.Fatal("answered for a tree leg A did not sign")
	}
	for size := uint64(8); size < 8+2*receiptCacheSize; size++ {
		r.accept(origin, size, root, sig)
	}
	if r.rootSignature(origin, 7, root) != nil {
		t.Fatal("the cache is unbounded")
	}
}
