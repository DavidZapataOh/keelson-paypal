package alibilog

import (
	"crypto/sha256"
	"errors"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	cose "github.com/veraison/go-cose"
)

// AlgorithmES256K is ECDSA over secp256k1 with SHA-256 (RFC 8812).
const AlgorithmES256K cose.Algorithm = -47

type es256kVerifier struct{ address [20]byte }

// ES256KVerifier verifies ES256K COSE signatures (low-S r || s) against an Ethereum address,
// recovering the key with both recovery ids.
func ES256KVerifier(address [20]byte) cose.Verifier { return es256kVerifier{address} }

func (v es256kVerifier) Algorithm() cose.Algorithm { return AlgorithmES256K }

func (v es256kVerifier) Verify(content, signature []byte) error {
	if len(signature) != 64 {
		return cose.ErrVerification
	}
	var s secp256k1.ModNScalar
	if overflow := s.SetByteSlice(signature[32:]); overflow || s.IsZero() || s.IsOverHalfOrder() {
		return cose.ErrVerification
	}
	digest := sha256.Sum256(content)
	for _, id := range []byte{27, 28} {
		compact := append([]byte{id}, signature...)
		pub, _, err := ecdsa.RecoverCompact(compact, digest[:])
		if err != nil {
			continue
		}
		h := keccak(pub.SerializeUncompressed()[1:])
		if [20]byte(h[12:]) == v.address {
			return nil
		}
	}
	return errors.Join(cose.ErrVerification, errors.New("no key of this address signed"))
}
