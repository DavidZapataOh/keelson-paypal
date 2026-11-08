package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"filippo.io/torchwood"
	sigsumcrypto "sigsum.org/sigsum-go/pkg/crypto"
	"sigsum.org/sigsum-go/pkg/proof"
)

const (
	// coLogInterval is how often co-logged checkpoints are looked for. The
	// log co-logs at most once every five minutes.
	coLogInterval = time.Minute
	// coLogPending bounds the verified sizes waiting to be found co-logged.
	coLogPending = 64
)

// coLogProbe checks the checkpoint bodies the log co-logs in Sigsum
// (sigsum/<size>.msg and .proof under the origin) against the checkpoints
// the monitor verified at the same sizes.
type coLogProbe struct {
	f     *follower
	sizes map[uint64][]byte
	last  time.Time
}

func newCoLogProbe(f *follower) *coLogProbe {
	p := &coLogProbe{f: f, sizes: map[uint64][]byte{}}
	if cur := f.st.Get(f.o.Name); len(cur.Checkpoint) > 0 {
		p.sizes[cur.Size] = cur.Checkpoint
	}
	return p
}

// pending records a verified checkpoint whose size may get co-logged.
func (p *coLogProbe) pending(size uint64, signed []byte) {
	p.sizes[size] = signed
	if len(p.sizes) > coLogPending {
		delete(p.sizes, slices.Min(slices.Collect(maps.Keys(p.sizes))))
	}
}

func (p *coLogProbe) maybeRun(ctx context.Context) {
	if p.f.sigsum == nil || time.Since(p.last) < coLogInterval {
		return
	}
	p.last = time.Now()
	for _, size := range slices.Sorted(maps.Keys(p.sizes)) {
		if err := p.check(ctx, size, p.sizes[size]); err != nil {
			p.f.log.Warn("sigsum", "size", size, "err", err)
		}
	}
}

func (p *coLogProbe) check(ctx context.Context, size uint64, signed []byte) error {
	name := "sigsum/" + strconv.FormatUint(size, 10)
	msg, err := p.get(ctx, name+".msg")
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	text, err := p.get(ctx, name+".proof")
	if err != nil {
		return err
	}
	delete(p.sizes, size)
	var sp proof.SigsumProof
	if err := sp.FromASCII(bytes.NewReader(text)); err != nil {
		p.f.finding(Finding{Kind: "sigsum", Detail: fmt.Sprintf("size %d: malformed proof: %v", size, err), At: time.Now()})
		return nil
	}
	h := sigsumcrypto.HashBytes(msg)
	if err := sp.Verify(&h, p.f.sigsum.SubmitKeys, p.f.sigsum.Policy); err != nil {
		p.f.finding(Finding{Kind: "sigsum", Detail: fmt.Sprintf("size %d: %v", size, err), At: time.Now()})
		return nil
	}
	if c, err := torchwood.ParseCheckpoint(string(msg)); err != nil || c.Origin != p.f.o.Name || uint64(c.N) != size {
		p.f.finding(Finding{Kind: "sigsum", Detail: fmt.Sprintf("size %d: the co-logged message is not a checkpoint of this origin and size", size), At: time.Now()})
		return nil
	}
	if !bytes.Equal(msg, []byte(checkpointBody(signed))) {
		e := newEquivocation(p.f.o.Name, "sigsum", signed, msg, nil)
		e.SigsumProof = string(text)
		p.f.equivocation(e)
		return nil
	}
	return p.f.st.Update(p.f.o.Name, func(s *OriginState) {
		if s.CoLogged == nil || s.CoLogged.Size <= size {
			s.CoLogged = &CoLog{Size: size, CheckedAt: time.Now()}
		}
	})
}

func (p *coLogProbe) get(ctx context.Context, name string) ([]byte, error) {
	u := p.f.o.URL.JoinPath(name)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	res, err := p.f.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, os.ErrNotExist
	default:
		return nil, fmt.Errorf("%s: %s", u, res.Status)
	}
	return io.ReadAll(io.LimitReader(res.Body, 64<<10))
}

// checkpointBody is the signed note's text, up to the blank line.
func checkpointBody(signed []byte) string {
	body, _, _ := strings.Cut(string(signed), "\n\n")
	return body + "\n"
}
