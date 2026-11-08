package main

import (
	"bytes"
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
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

// EquivocationSummary is an entry of the published list.
type EquivocationSummary struct {
	ID         string    `json:"id"`
	Origin     string    `json:"origin"`
	Kind       string    `json:"kind"`
	DetectedAt time.Time `json:"detectedAt"`
}

// equivocations stores each proof once, in <dir>/<id>.json, and never
// rewrites it.
type equivocations struct {
	dir string

	mu  sync.Mutex
	all map[string]*Equivocation
}

func openEquivocations(dir string) (*equivocations, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &equivocations{dir: dir, all: map[string]*Equivocation{}}
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		var e Equivocation
		if err := json.Unmarshal(raw, &e); err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		s.all[e.ID] = &e
	}
	return s, nil
}

// add stores e unless a proof with its ID exists, and returns the stored one.
func (s *equivocations) add(e *Equivocation) (*Equivocation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.all[e.ID]; ok {
		return old, nil
	}
	raw, err := json.Marshal(e)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(s.dir, e.ID+".json")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o444)
	if err != nil {
		return nil, err
	}
	if _, err := f.Write(raw); err != nil {
		f.Close()
		os.Remove(path)
		return nil, err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(path)
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	s.all[e.ID] = e
	return e, nil
}

func (s *equivocations) get(id string) (*Equivocation, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.all[id]
	return e, ok
}

// list returns every proof, oldest first.
func (s *equivocations) list() []EquivocationSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]EquivocationSummary, 0, len(s.all))
	for _, e := range s.all {
		out = append(out, EquivocationSummary{ID: e.ID, Origin: e.Origin, Kind: e.Kind, DetectedAt: e.DetectedAt})
	}
	slices.SortFunc(out, func(a, b EquivocationSummary) int {
		return cmp.Or(a.DetectedAt.Compare(b.DetectedAt), strings.Compare(a.ID, b.ID))
	})
	return out
}
