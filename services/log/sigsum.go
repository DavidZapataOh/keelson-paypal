package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"filippo.io/torchwood"
	"sigsum.org/sigsum-go/pkg/crypto"
	"sigsum.org/sigsum-go/pkg/proof"
	"sigsum.org/sigsum-go/pkg/submit"
)

const (
	// sigsumDomain is the domain whose _sigsum_v1 TXT record holds the
	// rate-limit key; the log counts submissions against it.
	sigsumDomain = "keelson.finance"
	// sigsumInterval spaces submissions across all origins: at most 288 a day,
	// the per-domain limit of the seasalp log.
	sigsumInterval = 5 * time.Minute
	// sigsumCadence is how often a grown log is co-logged without being asked.
	sigsumCadence = time.Hour
)

// CoLog submits the body of a checkpoint (origin, size and root lines) to the
// Sigsum logs of cfg's policy and returns the proof once the policy's witnesses
// cosigned a tree head that includes it. The Sigsum message is the SHA-256 of
// the body, so sigsum-verify checks the proof against the body as is.
func CoLog(ctx context.Context, cfg *submit.Config, signer crypto.Signer, body []byte) (proof.SigsumProof, error) {
	h := crypto.HashBytes(body)
	return submit.SubmitMessage(ctx, cfg, signer, &h)
}

// coLogger co-logs the checkpoints of every origin in Sigsum, one submission
// at a time and never more often than sigsumInterval, across restarts.
type coLogger struct {
	cfg       *submit.Config
	signer    crypto.Signer
	stateFile string
	log       *slog.Logger

	mu       sync.Mutex
	state    sigsumState
	inflight bool
	// submissions counts the submissions this process started.
	submissions int
}

type sigsumState struct {
	// Last is when the last submission started.
	Last time.Time `json:"last"`
	// Sizes is the size of the last co-logged checkpoint of each origin.
	Sizes map[string]int64 `json:"sizes"`
}

func newCoLogger(cfg *submit.Config, signer crypto.Signer, dataDir string, log *slog.Logger) (*coLogger, error) {
	c := &coLogger{
		cfg:       cfg,
		signer:    signer,
		stateFile: filepath.Join(dataDir, ".state", "sigsum.json"),
		log:       log,
		state:     sigsumState{Sizes: map[string]int64{}},
	}
	raw, err := os.ReadFile(c.stateFile)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return nil, err
	default:
		if err := json.Unmarshal(raw, &c.state); err != nil {
			return nil, fmt.Errorf("%s: %w", c.stateFile, err)
		}
	}
	return c, nil
}

// sigsumDir holds an origin's co-logged checkpoint bodies and their proofs.
func (o *origin) sigsumDir() string { return filepath.Join(o.dir, "sigsum") }

// coLogResult is the answer to a request to co-log an origin's checkpoint.
type coLogResult struct {
	Size       int64  `json:"size"`
	Proof      string `json:"proof,omitempty"`
	RetryAfter int    `json:"retryAfter,omitempty"`
}

var errTooSoon = errors.New("sigsum: too soon")

// now starts co-logging the origin's latest checkpoint. It returns the stored
// proof if that checkpoint is already co-logged, and errTooSoon with the wait
// if a submission is running or started less than sigsumInterval ago.
func (c *coLogger) now(ctx context.Context, o *origin) (*coLogResult, bool, error) {
	signed, err := o.reader.ReadCheckpoint(ctx)
	if err != nil {
		return nil, false, err
	}
	body := checkpointBody(signed)
	cp, err := torchwood.ParseCheckpoint(body)
	if err != nil {
		return nil, false, err
	}
	if p, err := os.ReadFile(filepath.Join(o.sigsumDir(), strconv.FormatInt(cp.N, 10)+".proof")); err == nil {
		return &coLogResult{Size: cp.N, Proof: string(p)}, true, nil
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if wait := sigsumInterval - time.Since(c.state.Last); c.inflight || wait > 0 {
		return &coLogResult{Size: cp.N, RetryAfter: max(1, int(wait.Seconds()+0.5))}, false, errTooSoon
	}
	// The slot is taken on disk before submitting, so a restart cannot reuse it.
	c.state.Last = time.Now()
	if err := c.save(); err != nil {
		return nil, false, err
	}
	c.inflight = true
	c.submissions++
	go c.submit(o, cp.N, []byte(body))
	return &coLogResult{Size: cp.N}, false, nil
}

func (c *coLogger) submit(o *origin, size int64, body []byte) {
	ctx, cancel := context.WithTimeout(context.Background(), submit.DefaultTimeout)
	defer cancel()
	start := time.Now()
	p, err := CoLog(ctx, c.cfg, c.signer, body)
	if err == nil {
		err = writeProof(o.sigsumDir(), size, body, p)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.inflight = false
	if err != nil {
		c.log.Error("sigsum", "origin", o.name, "size", size, "err", err)
		return
	}
	c.state.Sizes[o.name] = size
	if err := c.save(); err != nil {
		c.log.Error("sigsum state", "err", err)
	}
	c.log.Info("sigsum", "origin", o.name, "size", size, "duration", time.Since(start))
}

// writeProof stores <size>.msg, the checkpoint body, and <size>.proof.
func writeProof(dir string, size int64, body []byte, p proof.SigsumProof) error {
	var b strings.Builder
	if err := p.ToASCII(&b); err != nil {
		return err
	}
	name := filepath.Join(dir, strconv.FormatInt(size, 10))
	if err := writeAtomic(name+".msg", body); err != nil {
		return err
	}
	return writeAtomic(name+".proof", []byte(b.String()))
}

func writeAtomic(name string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		return err
	}
	tmp := name + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, name)
}

// save writes the state; the caller holds c.mu.
func (c *coLogger) save() error {
	raw, err := json.Marshal(c.state)
	if err != nil {
		return err
	}
	return writeAtomic(c.stateFile, raw)
}

// run co-logs every sigsumCadence the origins that grew since their last
// co-logged checkpoint.
func (c *coLogger) run(ctx context.Context, origins []*origin) {
	t := time.NewTicker(sigsumCadence)
	defer t.Stop()
	for {
		for _, o := range origins {
			n, err := o.size(ctx)
			c.mu.Lock()
			grew := err == nil && n > c.state.Sizes[o.name]
			c.mu.Unlock()
			if grew {
				if _, _, err := c.now(ctx, o); err != nil && !errors.Is(err, errTooSoon) {
					c.log.Error("sigsum", "origin", o.name, "err", err)
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
