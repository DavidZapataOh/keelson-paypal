package alibilog

import (
	"errors"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
)

// Signature errors.
var (
	ErrRecoveryID = errors.New("signature v is not 27 or 28")
	ErrHighS      = errors.New("signature s is in the upper half of the order")
	ErrSignature  = errors.New("signature does not recover a key")
)

// Recover returns the Ethereum address that signed digest with sig (r || s || v).
// Only low-S signatures with v in {27, 28} are accepted, as EIP-2 requires.
func Recover(digest [32]byte, sig [65]byte) ([20]byte, error) {
	var addr [20]byte
	v := sig[64]
	if v != 27 && v != 28 {
		return addr, ErrRecoveryID
	}
	var s secp256k1.ModNScalar
	if overflow := s.SetByteSlice(sig[32:64]); overflow || s.IsZero() {
		return addr, ErrSignature
	}
	if s.IsOverHalfOrder() {
		return addr, ErrHighS
	}
	var compact [65]byte
	compact[0] = v // 27 + recovery id, for an uncompressed key.
	copy(compact[1:], sig[:64])
	pub, _, err := ecdsa.RecoverCompact(compact[:], digest[:])
	if err != nil {
		return addr, ErrSignature
	}
	h := keccak(pub.SerializeUncompressed()[1:])
	copy(addr[:], h[12:])
	return addr, nil
}
