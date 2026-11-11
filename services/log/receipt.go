package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"errors"
	"strings"
	"sync"

	"github.com/fxamacker/cbor/v2"
	cose "github.com/veraison/go-cose"
)

// COSE labels and values of an RFC 9942 inclusion receipt.
const (
	algEd25519          cose.Algorithm = -19
	headerVDS                          = 395
	headerVDP                          = 396
	vdsRFC9162SHA256                   = 1
	inclusionProofLabel                = -1
)

var detEnc, _ = cbor.CoreDetEncOptions().EncMode()

// receiptProtected is the protected header of the origin's receipts: Ed25519, the key's SHA-256 as
// kid, the log host as issuer and the origin as subject, and the RFC9162_SHA256 data structure.
func receiptProtected(origin string, key ed25519.PublicKey) []byte {
	kid := sha256.Sum256(key)
	host, _, _ := strings.Cut(origin, "/")
	out, err := detEnc.Marshal(map[int]any{
		1:         int64(algEd25519),
		4:         kid[:],
		15:        map[int]string{1: "https://" + host, 2: origin},
		headerVDS: vdsRFC9162SHA256,
	})
	if err != nil {
		panic(err)
	}
	return out
}

// receiptToBeSigned is the Sig_structure over a detached root (RFC 9052 §4.4, RFC 9942 §5.2.1).
func receiptToBeSigned(origin string, key ed25519.PublicKey, root [32]byte) []byte {
	out, err := detEnc.Marshal([]any{"Signature1", receiptProtected(origin, key), []byte{}, root[:]})
	if err != nil {
		panic(err)
	}
	return out
}

// signReceiptRoot signs the root of a tree of the origin with a local receipt key.
func signReceiptRoot(key ed25519.PrivateKey, origin string, root [32]byte) []byte {
	return ed25519.Sign(key, receiptToBeSigned(origin, key.Public().(ed25519.PublicKey), root))
}

// buildReceipt is the RFC 9942 receipt of leaf index in a tree of size, with the root signature
// detached and one inclusion proof.
func buildReceipt(origin string, key ed25519.PublicKey, sig []byte, size, index uint64, path [][]byte) ([]byte, error) {
	if len(path) == 0 {
		return nil, errors.New("an inclusion path has a hash")
	}
	proof, err := detEnc.Marshal([]any{size, index, path})
	if err != nil {
		return nil, err
	}
	return detEnc.Marshal(cbor.Tag{Number: 18, Content: []any{
		receiptProtected(origin, key),
		map[int]any{headerVDP: map[int]any{inclusionProofLabel: [][]byte{proof}}},
		nil,
		sig,
	}})
}

type ed25519COSE struct{ key ed25519.PublicKey }

// ed25519Verifier verifies Ed25519 (-19, RFC 9864) COSE signatures.
func ed25519Verifier(key ed25519.PublicKey) cose.Verifier { return ed25519COSE{key} }

func (v ed25519COSE) Algorithm() cose.Algorithm { return algEd25519 }

func (v ed25519COSE) Verify(content, signature []byte) error {
	if !ed25519.Verify(v.key, content, signature) {
		return cose.ErrVerification
	}
	return nil
}

// receiptSource signs, or has, the root signature of an origin's tree of a given size.
type receiptSource interface {
	key() ed25519.PublicKey
	rootSignature(origin string, size uint64, root [32]byte) []byte
}

// localReceipts signs roots with a key held by the log, as for origins it signs itself.
type localReceipts struct{ priv ed25519.PrivateKey }

func (l localReceipts) key() ed25519.PublicKey { return l.priv.Public().(ed25519.PublicKey) }

func (l localReceipts) rootSignature(origin string, _ uint64, root [32]byte) []byte {
	return signReceiptRoot(l.priv, origin, root)
}

// receiptOf is the receipt of leaf index at the checkpoint size, or nil when the origin has no
// receipt key, leg A sent no signature for that root, or the tree has a single leaf.
func (o *origin) receiptOf(size, index uint64, root [32]byte, path [][]byte) []byte {
	if o.receipts == nil || len(path) == 0 {
		return nil
	}
	sig := o.receipts.rootSignature(o.name, size, root)
	if sig == nil {
		return nil
	}
	r, err := buildReceipt(o.name, o.receipts.key(), sig, size, index, path)
	if err != nil {
		return nil
	}
	return r
}

// keySet is the COSE_KeySet of every origin's receipt key (SCRAPI `/.well-known/scitt-keys`).
func keySet(origins []*origin) ([]byte, error) {
	set := []map[int]any{}
	for _, o := range origins {
		if o.receipts == nil {
			continue
		}
		k := o.receipts.key()
		kid := sha256.Sum256(k)
		set = append(set, map[int]any{1: 1, 2: kid[:], -1: 6, -2: []byte(k)})
	}
	return detEnc.Marshal(set)
}

// receiptCacheSize is how many of leg A's latest root signatures are kept: appends wait for the
// checkpoint that covers them, which is one of the last few.
const receiptCacheSize = 64

// remoteReceipts keeps the root signatures leg A returned with its checkpoint signatures.
type remoteReceipts struct {
	pub   ed25519.PublicKey
	mu    sync.Mutex
	sigs  map[uint64]rootSig
	order []uint64
}

type rootSig struct {
	root [32]byte
	sig  []byte
}

func newRemoteReceipts(pub ed25519.PublicKey) *remoteReceipts {
	return &remoteReceipts{pub: pub, sigs: map[uint64]rootSig{}}
}

func (r *remoteReceipts) key() ed25519.PublicKey { return r.pub }

// accept keeps sig if it is the pinned key's signature over root.
func (r *remoteReceipts) accept(origin string, size uint64, root [32]byte, sig []byte) bool {
	if !ed25519.Verify(r.pub, receiptToBeSigned(origin, r.pub, root), sig) {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.sigs[size]; !ok {
		r.order = append(r.order, size)
	}
	r.sigs[size] = rootSig{root, sig}
	for len(r.order) > receiptCacheSize {
		delete(r.sigs, r.order[0])
		r.order = r.order[1:]
	}
	return true
}

func (r *remoteReceipts) rootSignature(_ string, size uint64, root [32]byte) []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s, ok := r.sigs[size]; ok && s.root == root {
		return s.sig
	}
	return nil
}
