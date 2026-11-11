package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"time"

	"filippo.io/torchwood"
	"github.com/transparency-dev/formats/log"
	"github.com/transparency-dev/merkle/compact"
	"github.com/transparency-dev/merkle/rfc6962"
	"github.com/transparency-dev/tessera/client"
	"golang.org/x/mod/sumdb/note"
)

// Report is the monitor's view of one origin.
type Report struct {
	Origin     string `json:"origin"`
	Size       uint64 `json:"size"`
	Root       []byte `json:"root"`
	Checkpoint string `json:"checkpoint"`
	// Cosigners are the witnesses whose cosignatures on Checkpoint verify.
	Cosigners     []string  `json:"cosigners"`
	VerifiedAt    time.Time `json:"verifiedAt"`
	LeavesAudited uint64    `json:"leavesAudited"`
	// DegradedCount counts the audited leaves countersigned by the TDX leg
	// alone, which happens only while the Nitro leg is down; DegradedLeaves
	// lists the latest of their indices.
	DegradedCount  uint64    `json:"degradedCount"`
	DegradedLeaves []uint64  `json:"degradedLeaves"`
	Findings       []Finding `json:"findings"`
	CoLogged       *CoLog    `json:"coLogged,omitempty"`
	// Error is why the last check could not run, such as the log being
	// unreachable. It is not a finding.
	Error string `json:"error,omitempty"`
}

// Event is what a follower emits: a new verified report or an equivocation.
type Event struct {
	Report       *Report
	Equivocation *Equivocation
}

// findingError is a check that failed: the log served something it must not.
type findingError struct {
	Kind  string
	Index *uint64
	Err   error
}

func (e *findingError) Error() string { return e.Kind + ": " + e.Err.Error() }

// equivocationError carries two validly signed, conflicting checkpoints.
type equivocationError struct{ E *Equivocation }

func (e *equivocationError) Error() string { return "equivocation: " + e.E.Kind }

// follower follows one origin with Tessera's LogStateTracker.
type follower struct {
	o       *origin
	st      *State
	out     chan<- Event
	fetcher *client.HTTPFetcher
	hc      *http.Client
	sigsum  *sigsumTrust
	log     *slog.Logger
	tracker *client.LogStateTracker
	// fetched is the checkpoint the last consensus call verified.
	fetched []byte
	// equivocated holds the kinds of equivocation already recorded against
	// the view at each size, so a growing fork yields one proof.
	equivocated map[string]bool
	colog       *coLogProbe
}

// Follow checks the origin every poll until ctx is done.
func Follow(ctx context.Context, o *origin, st *State, poll time.Duration, sigsum *sigsumTrust, hc *http.Client, out chan<- Event, logger *slog.Logger) {
	fetcher, err := client.NewHTTPFetcher(o.URL, hc)
	if err != nil {
		panic(err) // o.URL is validated by newOrigin.
	}
	f := &follower{o: o, st: st, out: out, fetcher: fetcher, hc: hc, sigsum: sigsum, log: logger.With("origin", o.Name)}
	f.colog = newCoLogProbe(f)
	t := time.NewTicker(poll)
	defer t.Stop()
	for {
		f.step(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// step runs one round of checks and records its outcome.
func (f *follower) step(ctx context.Context) {
	err := f.check(ctx)
	if ctx.Err() != nil {
		return
	}
	var fe *findingError
	var ee *equivocationError
	switch {
	case err == nil:
		f.st.verified(f.o.Name, time.Now())
		f.colog.maybeRun(ctx)
		return
	case errors.As(err, &ee):
		f.equivocation(ee.E)
	case errors.As(err, &fe):
		f.finding(Finding{Kind: fe.Kind, Index: fe.Index, Detail: fe.Err.Error(), At: time.Now()})
	default:
		f.log.Warn("check", "err", err)
	}
	f.st.failed(f.o.Name, err)
}

func (f *follower) finding(fd Finding) {
	if err := f.st.Update(f.o.Name, func(s *OriginState) { s.addFinding(fd) }); err != nil {
		f.log.Error("state", "err", err)
	}
	f.log.Warn("finding", "kind", fd.Kind, "detail", fd.Detail)
}

func (f *follower) equivocation(e *Equivocation) {
	cur := f.st.Get(f.o.Name)
	key := fmt.Sprintf("%s %d", e.Kind, cur.Size)
	if f.equivocated[key] {
		return
	}
	if f.equivocated == nil {
		f.equivocated = map[string]bool{}
	}
	f.equivocated[key] = true
	f.finding(Finding{Kind: "equivocation", Detail: e.Kind + " " + e.ID, At: e.DetectedAt})
	f.emit(Event{Equivocation: e})
}

func (f *follower) emit(e Event) {
	select {
	case f.out <- e:
	default:
		// The consumer is gone or stuck; the state on disk still has it.
		f.log.Error("event dropped")
	}
}

// check fetches the latest checkpoint, proves it consistent with the verified
// view, and audits every new leaf before accepting it.
func (f *follower) check(ctx context.Context) error {
	cur := f.st.Get(f.o.Name)
	if f.tracker == nil {
		t, err := client.NewLogStateTracker(ctx, f.fetcher.ReadTile, cur.Checkpoint, f.viewKey(cur.Checkpoint), f.o.Name, f.consensus)
		if err != nil {
			return err
		}
		f.tracker = t
	}
	f.fetched = nil
	_, _, _, err := f.tracker.Update(ctx)
	var inc client.ErrInconsistency
	if errors.As(err, &inc) {
		return &equivocationError{newEquivocation(f.o.Name, "inconsistent", inc.SmallerRaw, inc.LargerRaw, inc.Proof)}
	}
	if err != nil {
		return err
	}
	latest := f.tracker.Latest()
	if f.fetched == nil || latest.Size < cur.Size {
		return nil
	}
	if latest.Size == cur.Size && len(cur.Checkpoint) > 0 {
		// The same tree, maybe with newer cosignatures.
		if !bytes.Equal(f.fetched, cur.Checkpoint) {
			return f.st.Update(f.o.Name, func(s *OriginState) { s.Checkpoint = f.fetched })
		}
		return nil
	}
	if err := f.accept(ctx, cur, latest, f.fetched); err != nil {
		// Start again from the verified view on the next round.
		f.tracker = nil
		return err
	}
	r := f.report()
	f.emit(Event{Report: &r})
	return nil
}

// consensus returns the log's checkpoint only if it satisfies the pinned
// policy and does not conflict with the verified view at its size.
// viewKey is the key the saved view opens with: the log's, or a key it
// retired whose bound covers the view, so a moved key does not stop the
// monitor. The log's next checkpoints must still be signed with its key.
func (f *follower) viewKey(saved []byte) note.Verifier {
	if len(saved) == 0 {
		return f.o.Verifier
	}
	if _, _, _, err := log.ParseCheckpoint(saved, f.o.Name, f.o.Verifier); err == nil {
		return f.o.Verifier
	}
	for _, r := range f.o.Retired {
		if c, _, _, err := log.ParseCheckpoint(saved, f.o.Name, r.Verifier); err == nil && c.Size <= r.UntilSize {
			return r.Verifier
		}
	}
	return f.o.Verifier
}

func (f *follower) consensus(ctx context.Context, _ note.Verifier, origin string) (*log.Checkpoint, []byte, *note.Note, error) {
	raw, err := f.fetcher.ReadCheckpoint(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	if _, _, err := torchwood.VerifyCheckpoint(raw, f.o.Policy); err != nil {
		return nil, nil, nil, &findingError{Kind: "checkpoint.signature", Err: err}
	}
	c, _, n, err := log.ParseCheckpoint(raw, origin, f.o.Verifier)
	if err != nil {
		return nil, nil, nil, &findingError{Kind: "checkpoint.signature", Err: err}
	}
	cur := f.st.Get(f.o.Name)
	if len(cur.Checkpoint) > 0 {
		switch {
		case c.Size == cur.Size && !bytes.Equal(c.Hash, cur.Root):
			return nil, nil, nil, &equivocationError{newEquivocation(f.o.Name, "same-size", cur.Checkpoint, raw, nil)}
		case c.Size < cur.Size:
			return nil, nil, nil, &findingError{Kind: "checkpoint.rollback",
				Err: fmt.Errorf("the log serves size %d below the verified size %d", c.Size, cur.Size)}
		}
	}
	f.fetched = raw
	return c, raw, n, nil
}

var rangeFactory = &compact.RangeFactory{Hash: rfc6962.DefaultHasher.HashChildren}

// accept audits the leaves [cur.Size, latest.Size) and records the new view.
func (f *follower) accept(ctx context.Context, cur OriginState, latest log.Checkpoint, signed []byte) error {
	rng, err := rangeFactory.NewRange(0, cur.Size, cur.Range)
	if err != nil {
		return fmt.Errorf("stored range: %w", err)
	}
	res, err := audit(ctx, f.fetcher.ReadEntryBundle, rng, latest.Size)
	if err != nil {
		return err
	}
	root := rfc6962.DefaultHasher.EmptyRoot()
	if rng.End() > 0 {
		if root, err = rng.GetRootHash(nil); err != nil {
			return err
		}
	}
	if !bytes.Equal(root, latest.Hash) {
		return &findingError{Kind: "leaf.inclusion",
			Err: fmt.Errorf("the entries up to %d hash to a root other than the checkpoint's", latest.Size)}
	}
	now := time.Now()
	err = f.st.Update(f.o.Name, func(s *OriginState) {
		s.Checkpoint = signed
		s.Size = latest.Size
		s.Root = latest.Hash
		s.Range = rng.Hashes()
		s.LeavesAudited += latest.Size - cur.Size
		s.addDegraded(res.degraded)
		for _, fd := range res.findings {
			fd.At = now
			s.addFinding(fd)
		}
	})
	if err != nil {
		return err
	}
	f.colog.pending(latest.Size, signed)
	return nil
}

func (f *follower) report() Report {
	return buildReport(f.o, f.st)
}

func buildReport(o *origin, st *State) Report {
	s := st.Get(o.Name)
	at, lastErr := st.status(o.Name)
	return Report{
		Origin:         o.Name,
		Size:           s.Size,
		Root:           s.Root,
		Checkpoint:     string(s.Checkpoint),
		Cosigners:      cosigners(o, s.Checkpoint),
		VerifiedAt:     at,
		LeavesAudited:  s.LeavesAudited,
		DegradedCount:  s.DegradedCount,
		DegradedLeaves: append([]uint64{}, s.DegradedLeaves...),
		Findings:       append([]Finding{}, s.Findings...),
		CoLogged:       s.CoLogged,
		Error:          lastErr,
	}
}

// cosigners returns the names of the witnesses whose cosignatures on the
// signed checkpoint verify under the origin's policy.
func cosigners(o *origin, signed []byte) []string {
	out := []string{}
	if len(signed) == 0 {
		return out
	}
	n, err := note.Open(signed, o.Policy)
	if err != nil {
		return out
	}
	for _, s := range n.Sigs {
		if s.Name != o.Name && !slices.Contains(out, s.Name) {
			out = append(out, s.Name)
		}
	}
	slices.Sort(out)
	return out
}
