package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// maxFindings bounds the findings kept per origin; the oldest are dropped.
const maxFindings = 1000

// maxGossiped bounds the checkpoints kept per gossip-only origin; the
// smallest sizes are dropped.
const maxGossiped = 1000

// Finding is something the monitor checked and found wrong.
type Finding struct {
	// Kind is checkpoint.signature, checkpoint.rollback, leaf.format,
	// leaf.inclusion, sigsum or equivocation.
	Kind   string    `json:"kind"`
	Index  *uint64   `json:"index,omitempty"`
	Detail string    `json:"detail"`
	At     time.Time `json:"at"`
}

// OriginState is what the monitor verified of one origin.
type OriginState struct {
	// Checkpoint is the latest verified signed checkpoint, Size and Root its
	// tree, and Range the compact range of its leaves.
	Checkpoint []byte   `json:"checkpoint,omitempty"`
	Size       uint64   `json:"size"`
	Root       []byte   `json:"root,omitempty"`
	Range      [][]byte `json:"range,omitempty"`
	// LeavesAudited counts the leaves whose format and inclusion were checked.
	LeavesAudited uint64 `json:"leavesAudited"`
	// DegradedLeaves are the indices of leaves countersigned by the TDX leg alone.
	DegradedLeaves []uint64  `json:"degradedLeaves"`
	Findings       []Finding `json:"findings"`
	// CoLogged is the last co-logged checkpoint the monitor checked in Sigsum.
	CoLogged *CoLog `json:"coLogged,omitempty"`
	// Gossiped holds one signed checkpoint per size for an origin known only
	// through gossip.
	Gossiped map[uint64][]byte `json:"gossiped,omitempty"`
}

// CoLog is a checkpoint body whose Sigsum proof the monitor verified.
type CoLog struct {
	Size      uint64    `json:"size"`
	CheckedAt time.Time `json:"checkedAt"`
}

func (o *OriginState) addFinding(f Finding) {
	for _, g := range o.Findings {
		if g.Kind == f.Kind && g.Detail == f.Detail && ((g.Index == nil) == (f.Index == nil)) && (g.Index == nil || *g.Index == *f.Index) {
			return
		}
	}
	o.Findings = append(o.Findings, f)
	if n := len(o.Findings); n > maxFindings {
		o.Findings = slices.Delete(o.Findings, 0, n-maxFindings)
	}
}

func (o *OriginState) addGossiped(size uint64, signed []byte) {
	if o.Gossiped == nil {
		o.Gossiped = map[uint64][]byte{}
	}
	o.Gossiped[size] = signed
	if len(o.Gossiped) > maxGossiped {
		delete(o.Gossiped, slices.Min(slices.Collect(maps.Keys(o.Gossiped))))
	}
}

func (o OriginState) clone() OriginState {
	o.Checkpoint = slices.Clone(o.Checkpoint)
	o.Root = slices.Clone(o.Root)
	o.Range = slices.Clone(o.Range)
	o.DegradedLeaves = slices.Clone(o.DegradedLeaves)
	o.Findings = slices.Clone(o.Findings)
	o.Gossiped = maps.Clone(o.Gossiped)
	if o.CoLogged != nil {
		c := *o.CoLogged
		o.CoLogged = &c
	}
	return o
}

// State is the monitor's verified view, kept in one file so a restart
// resumes from it and a log rolled back below it is caught.
type State struct {
	path string

	mu      sync.Mutex
	origins map[string]*OriginState
	// verifiedAt and lastError are kept in memory only.
	verifiedAt map[string]time.Time
	lastError  map[string]string
}

func openState(dir string) (*State, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &State{
		path:       filepath.Join(dir, "state.json"),
		origins:    map[string]*OriginState{},
		verifiedAt: map[string]time.Time{},
		lastError:  map[string]string{},
	}
	raw, err := os.ReadFile(s.path)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return nil, err
	default:
		if err := json.Unmarshal(raw, &s.origins); err != nil {
			return nil, fmt.Errorf("%s: %w", s.path, err)
		}
	}
	return s, nil
}

// Get returns a copy of what the monitor verified of the origin.
func (s *State) Get(name string) OriginState {
	s.mu.Lock()
	defer s.mu.Unlock()
	if o := s.origins[name]; o != nil {
		return o.clone()
	}
	return OriginState{}
}

// Update applies change to the origin and writes the state to disk before
// returning. On a write error the change is discarded.
func (s *State) Update(name string, change func(*OriginState)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.origins[name]
	var o OriginState
	if old != nil {
		o = old.clone()
	}
	change(&o)
	s.origins[name] = &o
	if err := s.save(); err != nil {
		if old == nil {
			delete(s.origins, name)
		} else {
			s.origins[name] = old
		}
		return err
	}
	return nil
}

// verified records that the origin's latest checkpoint verified at t.
func (s *State) verified(name string, t time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.verifiedAt[name] = t
	delete(s.lastError, name)
}

// failed records why the origin could not be checked, such as the log being
// unreachable. It is not a finding.
func (s *State) failed(name string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastError[name] = err.Error()
}

func (s *State) status(name string) (time.Time, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.verifiedAt[name], s.lastError[name]
}

// save writes the state atomically: temporary file, fsync, rename, fsync of
// the directory. The caller holds s.mu.
func (s *State) save() error {
	raw, err := json.Marshal(s.origins)
	if err != nil {
		return err
	}
	return writeFileAtomic(s.path, raw)
}

func writeFileAtomic(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(f.Name(), path); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
