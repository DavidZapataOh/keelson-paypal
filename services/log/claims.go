package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// errClaimed is returned when a purchase already has another leaf in the log.
var errClaimed = errors.New("the purchase already has another leaf")

// claims records, on the log's disk, the leaf hash each alibi_id was logged
// with, so a purchase has one leaf in the log across restarts.
type claims struct {
	dir   string
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

func newClaims(originDir string) (*claims, error) {
	dir := filepath.Join(originDir, ".state", "alibi")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &claims{dir: dir, locks: map[string]*sync.Mutex{}}, nil
}

// lock serializes appends for one alibi_id; the caller unlocks.
func (c *claims) lock(alibiID string) *sync.Mutex {
	c.mu.Lock()
	m, ok := c.locks[alibiID]
	if !ok {
		m = &sync.Mutex{}
		c.locks[alibiID] = m
	}
	c.mu.Unlock()
	m.Lock()
	return m
}

// check returns errClaimed if alibiID was logged with a leaf other than leafHash.
func (c *claims) check(alibiID string, leafHash [32]byte) error {
	got, err := os.ReadFile(filepath.Join(c.dir, alibiID))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !bytes.Equal(got, leafHash[:]) {
		return errClaimed
	}
	return nil
}

// record durably stores the leaf hash alibiID was logged with.
func (c *claims) record(alibiID string, leafHash [32]byte) error {
	path := filepath.Join(c.dir, alibiID)
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	f, err := os.CreateTemp(c.dir, ".tmp-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(leafHash[:]); err != nil {
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
	return os.Rename(f.Name(), path)
}
