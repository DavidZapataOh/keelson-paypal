package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"time"
)

// Equivocation is the proof that a log showed two views that cannot both be
// true: two validly signed checkpoints of one origin with the same size and
// different roots, two that no consistency proof joins, or a checkpoint and
// a different body the log co-logged in Sigsum at the same size.
type Equivocation struct {
	ID     string `json:"id"`
	Origin string `json:"origin"`
	// Kind is same-size, inconsistent or sigsum.
	Kind string `json:"kind"`
	A    string `json:"a"`
	B    string `json:"b"`
	// ConsistencyProof is the proof from A to B that failed to verify.
	ConsistencyProof [][]byte `json:"consistencyProof,omitempty"`
	// SigsumProof is the Sigsum proof of B, a co-logged checkpoint body.
	SigsumProof string    `json:"sigsumProof,omitempty"`
	DetectedAt  time.Time `json:"detectedAt"`
}

// newEquivocation identifies the proof by the SHA-256 of the two checkpoint
// bodies, sorted, so the same pair of views is one proof however often its
// checkpoints are re-signed.
func newEquivocation(origin, kind string, a, b []byte, proof [][]byte) *Equivocation {
	ba, bb := []byte(checkpointBody(a)), []byte(checkpointBody(b))
	if bytes.Compare(ba, bb) > 0 {
		ba, bb = bb, ba
	}
	id := sha256.Sum256(append(append([]byte{}, ba...), bb...))
	return &Equivocation{
		ID:               hex.EncodeToString(id[:]),
		Origin:           origin,
		Kind:             kind,
		A:                string(a),
		B:                string(b),
		ConsistencyProof: proof,
		DetectedAt:       time.Now().UTC(),
	}
}
