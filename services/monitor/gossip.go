package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"filippo.io/torchwood"
	"github.com/transparency-dev/merkle/proof"
	"github.com/transparency-dev/merkle/rfc6962"
	"github.com/transparency-dev/tessera/client"
)

// Gossip statuses: how a checkpoint someone else saw compares with the
// monitor's view.
const (
	gossipConsistent = "consistent"
	gossipAhead      = "ahead"
	gossipBehind     = "behind"
)

const (
	// gossipTimeout bounds reading the log to check one gossiped checkpoint.
	gossipTimeout = 5 * time.Second
	// maxGossipCache bounds the checkpoints remembered as agreeing.
	maxGossipCache = 4096
)

// errGossipRejected is a checkpoint the monitor cannot check: an unknown
// origin or signatures that do not verify under the pinned log keys.
var errGossipRejected = errors.New("gossip rejected")

// gossip checks a signed checkpoint from anyone against the monitor's view.
// Only the log's signatures are required, so a split view shown to a single
// user is still caught. It returns the stored equivocation if the checkpoint
// conflicts with the view.
func (m *monitor) gossip(ctx context.Context, signed []byte) (string, *Equivocation, error) {
	name, _, _ := strings.Cut(string(signed), "\n")
	o := m.originNamed(name)
	if o == nil {
		return "", nil, fmt.Errorf("%w: unknown origin %q", errGossipRejected, name)
	}
	c, _, err := torchwood.VerifyCheckpoint(signed, o.LogPolicy)
	if err != nil {
		return "", nil, fmt.Errorf("%w: %v", errGossipRejected, err)
	}
	if o == m.cfg.Conformance {
		return m.gossipOnly(o, uint64(c.N), signed)
	}
	m.gossipMu.Lock()
	defer m.gossipMu.Unlock()
	cur := m.st.Get(o.Name)
	n, root := uint64(c.N), c.Hash[:]
	if len(cur.Checkpoint) == 0 {
		return gossipAhead, nil, nil
	}
	// A checkpoint already found to agree with this view is answered without
	// reading the log again, so replaying public checkpoints costs nothing.
	key := checkpointBody(cur.Checkpoint) + checkpointBody(signed)
	if status, ok := m.gossiped[key]; ok {
		return status, nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, gossipTimeout)
	defer cancel()
	var e *Equivocation
	status := gossipConsistent
	switch {
	case n == cur.Size:
		if !bytes.Equal(root, cur.Root) {
			e = newEquivocation(o.Name, "same-size", cur.Checkpoint, signed, nil)
		}
	case n < cur.Size:
		status = gossipBehind
		if n == 0 {
			break
		}
		p, err := m.consistencyProof(ctx, o, n, cur.Size, cur.Size)
		if err != nil {
			return "", nil, err
		}
		if proof.VerifyConsistency(rfc6962.DefaultHasher, n, cur.Size, p, root, cur.Root) != nil {
			e = newEquivocation(o.Name, "inconsistent", signed, cur.Checkpoint, p)
		}
	default:
		status = gossipAhead
		if cur.Size == 0 {
			break
		}
		// The log's tiles at the gossiped size join the two views, unless
		// the log has not published that size to the monitor yet.
		p, err := m.consistencyProof(ctx, o, cur.Size, n, n)
		if errors.Is(err, os.ErrNotExist) {
			return gossipAhead, nil, nil
		}
		if err != nil {
			return "", nil, err
		}
		if proof.VerifyConsistency(rfc6962.DefaultHasher, cur.Size, n, p, cur.Root, root) != nil {
			e = newEquivocation(o.Name, "inconsistent", cur.Checkpoint, signed, p)
		}
	}
	if e != nil {
		stored, err := m.recordEquivocation(e)
		return "", stored, err
	}
	if len(m.gossiped) >= maxGossipCache {
		clear(m.gossiped)
	}
	m.gossiped[key] = status
	return status, nil, nil
}

// consistencyProof builds the proof from size from to size to from the log's
// tiles at treeSize.
func (m *monitor) consistencyProof(ctx context.Context, o *origin, from, to, treeSize uint64) ([][]byte, error) {
	f, err := client.NewHTTPFetcher(o.URL, m.hc)
	if err != nil {
		return nil, err
	}
	// The client does not wrap fetch errors, so a missing tile is noted here.
	missing := false
	readTile := func(ctx context.Context, level, index uint64, p uint8) ([]byte, error) {
		b, err := f.ReadTile(ctx, level, index, p)
		missing = missing || errors.Is(err, os.ErrNotExist)
		return b, err
	}
	pb, err := client.NewProofBuilder(ctx, treeSize, readTile)
	if err != nil {
		return nil, err
	}
	proof, err := pb.ConsistencyProof(ctx, from, to)
	if err != nil && missing {
		return nil, fmt.Errorf("%w: %v", os.ErrNotExist, err)
	}
	return proof, err
}

// gossipOnly checks a checkpoint of an origin the monitor knows only through
// gossip: it keeps one checkpoint per size and flags a second root at a size
// it holds.
func (m *monitor) gossipOnly(o *origin, n uint64, signed []byte) (string, *Equivocation, error) {
	m.gossipMu.Lock()
	defer m.gossipMu.Unlock()
	cur := m.st.Get(o.Name)
	if prev, ok := cur.Gossiped[n]; ok {
		if checkpointBody(prev) == checkpointBody(signed) {
			return gossipConsistent, nil, nil
		}
		stored, err := m.recordEquivocation(newEquivocation(o.Name, "same-size", prev, signed, nil))
		return "", stored, err
	}
	status := gossipAhead
	if len(cur.Gossiped) > 0 && n < slices.Max(slices.Collect(maps.Keys(cur.Gossiped))) {
		status = gossipBehind
	}
	if err := m.st.Update(o.Name, func(s *OriginState) { s.addGossiped(n, signed) }); err != nil {
		return "", nil, err
	}
	return status, nil, nil
}

// recordEquivocation stores the proof and adds it to the origin's findings.
func (m *monitor) recordEquivocation(e *Equivocation) (*Equivocation, error) {
	stored, err := m.eqs.add(e)
	if err != nil {
		return nil, err
	}
	if stored == e {
		err = m.st.Update(e.Origin, func(s *OriginState) {
			s.addFinding(Finding{Kind: "equivocation", Detail: e.Kind + " " + e.ID, At: e.DetectedAt})
		})
		m.log.Warn("equivocation", "origin", e.Origin, "kind", e.Kind, "id", e.ID)
	}
	return stored, err
}

func (m *monitor) originNamed(name string) *origin {
	for _, o := range append(slices.Clone(m.cfg.Origins), m.cfg.Conformance) {
		if o.Name == name {
			return o
		}
	}
	return nil
}

// rateLimiter allows n requests per window per client.
type rateLimiter struct {
	n      int
	window time.Duration

	mu    sync.Mutex
	seen  map[string][]time.Time
	swept time.Time
}

func newRateLimiter(n int, window time.Duration) *rateLimiter {
	return &rateLimiter{n: n, window: window, seen: map[string][]time.Time{}}
}

func (l *rateLimiter) allow(client string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	recent := func(ts []time.Time) []time.Time {
		return slices.DeleteFunc(ts, func(t time.Time) bool { return now.Sub(t) >= l.window })
	}
	// Clients idle for a window are forgotten, at most once a window.
	if now.Sub(l.swept) >= l.window {
		l.swept = now
		for k, ts := range l.seen {
			if ts = recent(ts); len(ts) == 0 {
				delete(l.seen, k)
			} else {
				l.seen[k] = ts
			}
		}
	}
	ts := recent(l.seen[client])
	if len(ts) >= l.n {
		l.seen[client] = ts
		return false
	}
	l.seen[client] = append(ts, now)
	return true
}
