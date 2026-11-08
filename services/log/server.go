package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"filippo.io/torchwood"
	"filippo.io/torchwood/tesserax"
	"github.com/DavidZapataOh/keelson-paypal/internal/alibilog"
	"github.com/transparency-dev/tessera"
	"github.com/transparency-dev/tessera/storage/posix"
	badger_as "github.com/transparency-dev/tessera/storage/posix/antispam"
	"golang.org/x/mod/sumdb/note"
	"golang.org/x/mod/sumdb/tlog"
)

// awaitTimeout bounds how long an append waits for a checkpoint that covers it.
const awaitTimeout = 5 * time.Second

// witnessTimeout bounds how long a checkpoint waits for its witness quorum.
// Without the quorum the checkpoint is not published.
const witnessTimeout = time.Second

// origin is one Tessera log on its own directory.
type origin struct {
	name              string
	path              string
	dir               string
	chainID           uint64
	verifyingContract [20]byte
	add               tessera.AddFn
	reader            tessera.LogReader
	awaiter           *tessera.PublicationAwaiter
	shutdown          func(context.Context) error
	claims            *claims
	policy            []byte
}

func openOrigin(ctx context.Context, spec originSpec, dir string, verifyingContract [20]byte, signers []note.Signer, policy []byte) (*origin, error) {
	witnesses, err := tessera.NewWitnessGroupFromPolicy(policy)
	if err != nil {
		return nil, err
	}
	driver, err := posix.New(ctx, posix.Config{Path: dir})
	if err != nil {
		return nil, err
	}
	as, err := badger_as.NewAntispam(ctx, filepath.Join(dir, ".state", "antispam"), badger_as.AntispamOpts{})
	if err != nil {
		return nil, err
	}
	appender, shutdown, reader, err := tessera.NewAppender(ctx, driver, tessera.NewAppendOptions().
		WithCheckpointSigner(signers[0], signers[1:]...).
		WithCheckpointInterval(500*time.Millisecond).
		WithCheckpointRepublishInterval(time.Minute).
		WithBatching(256, 250*time.Millisecond).
		WithPushback(4096).
		WithAntispam(tessera.DefaultAntispamInMemorySize, as).
		WithWitnesses(witnesses, &tessera.WitnessOptions{Timeout: witnessTimeout}))
	if err != nil {
		return nil, err
	}
	cl, err := newClaims(dir)
	if err != nil {
		return nil, err
	}
	return &origin{
		claims:            cl,
		policy:            policy,
		name:              spec.Name,
		path:              spec.path(),
		dir:               dir,
		chainID:           spec.ChainID,
		verifyingContract: verifyingContract,
		add:               appender.Add,
		reader:            reader,
		awaiter:           tessera.NewPublicationAwaiter(ctx, reader.ReadCheckpoint, 50*time.Millisecond),
		shutdown:          shutdown,
	}, nil
}

// appendResult is the answer to an admitted append.
type appendResult struct {
	Index      string `json:"index"`
	LeafHash   string `json:"leafHash"`
	Proof      string `json:"proof"`
	Checkpoint string `json:"checkpoint"`
}

// append adds the leaf and waits for a checkpoint that covers it, then proves
// the leaf's inclusion in that checkpoint (c2sp.org/tlog-proof@v1).
func (o *origin) append(ctx context.Context, leaf []byte) (*appendResult, error) {
	ctx, cancel := context.WithTimeout(ctx, awaitTimeout)
	defer cancel()
	idx, cp, err := o.awaiter.Await(ctx, o.add(ctx, tessera.NewEntry(leaf)))
	if err != nil {
		return nil, err
	}
	c, err := torchwood.ParseCheckpoint(checkpointBody(cp))
	if err != nil {
		return nil, err
	}
	i := int64(idx.Index)
	p, err := tlog.ProveRecord(c.N, i, torchwood.TileHashReaderWithContext(ctx, c.Tree, tesserax.NewTileReader(o.reader)))
	if err != nil {
		return nil, fmt.Errorf("inclusion proof: %w", err)
	}
	h := alibilog.LeafHash(leaf)
	return &appendResult{
		Index:      strconv.FormatUint(idx.Index, 10),
		LeafHash:   hex.EncodeToString(h[:]),
		Proof:      string(torchwood.FormatProof(i, p, cp)),
		Checkpoint: string(cp),
	}, nil
}

// appendOnce appends the leaf unless its purchase is already claimed by
// another leaf. The claim is written before the append and kept even if the
// append fails, so a retry can only send the same bytes, which get the same
// index. The append outlives the caller's request.
func (o *origin) appendOnce(ctx context.Context, leaf []byte) (*appendResult, error) {
	l, err := alibilog.Parse(leaf)
	if err != nil {
		return nil, err
	}
	h := alibilog.LeafHash(leaf)
	unlock := o.claims.lock(l.AlibiID)
	defer unlock()
	if err := o.claims.check(l.AlibiID, h); err != nil {
		return nil, err
	}
	if err := o.claims.record(l.AlibiID, h); err != nil {
		return nil, err
	}
	return o.append(context.WithoutCancel(ctx), leaf)
}

// checkpointBody is the signed note's text, up to the blank line.
func checkpointBody(signed []byte) string {
	body, _, _ := bytes.Cut(signed, []byte("\n\n"))
	return string(body) + "\n"
}

// size is the tree size of the latest checkpoint.
func (o *origin) size(ctx context.Context) (int64, error) {
	cp, err := o.reader.ReadCheckpoint(ctx)
	if err != nil {
		return 0, err
	}
	c, err := torchwood.ParseCheckpoint(checkpointBody(cp))
	return c.N, err
}

type server struct {
	origins   []*origin
	registry  registry
	tokenHash [32]byte
	log       *slog.Logger
	// colog is nil when co-logging in Sigsum is off.
	colog *coLogger
	// anchor is nil when on-chain anchoring is off.
	anchor *anchorer
}

// authorized reports whether r carries the write token.
func (s *server) authorized(r *http.Request) bool {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	sum := sha256.Sum256([]byte(token))
	return ok && subtle.ConstantTimeCompare(sum[:], s.tokenHash[:]) == 1
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type addRequest struct {
	Leaf        []byte               `json:"leaf"`
	Countersign alibilog.Countersign `json:"countersign"`
}

// private serves POST /<origin path>/add, POST /<origin path>/sigsum and
// POST /<origin path>/anchor, reached only over the private network, and the
// public resources for the API's health checks.
func (s *server) private() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /", s.public())
	for _, o := range s.origins {
		if t := s.anchorTarget(o); t != nil {
			mux.HandleFunc("POST /"+o.path+"/anchor", func(w http.ResponseWriter, r *http.Request) {
				if !s.authorized(r) {
					writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "unauthorized"})
					return
				}
				res, err := s.anchor.now(r.Context(), t)
				switch {
				case errors.Is(err, errTEEUnavailable):
					s.log.Error("anchor", "origin", o.name, "err", err)
					writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "tee_unavailable"})
				case errors.Is(err, errFork):
					s.log.Error("anchor: the log contradicts its anchors", "origin", o.name, "err", err)
					writeJSON(w, http.StatusConflict, map[string]string{"code": "fork"})
				case errors.Is(err, errChain):
					s.log.Error("anchor", "origin", o.name, "err", err)
					writeJSON(w, http.StatusBadGateway, map[string]string{"code": "chain"})
				case err != nil:
					s.log.Error("anchor", "origin", o.name, "err", err)
					writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "unavailable"})
				default:
					writeJSON(w, http.StatusOK, res)
				}
			})
		}
		if s.colog != nil {
			mux.HandleFunc("POST /"+o.path+"/sigsum", func(w http.ResponseWriter, r *http.Request) {
				if !s.authorized(r) {
					writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "unauthorized"})
					return
				}
				res, done, err := s.colog.now(r.Context(), o)
				switch {
				case errors.Is(err, errTooSoon):
					w.Header().Set("Retry-After", strconv.Itoa(res.RetryAfter))
					writeJSON(w, http.StatusTooManyRequests, res)
				case err != nil:
					s.log.Error("sigsum", "origin", o.name, "err", err)
					writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "unavailable"})
				case done:
					writeJSON(w, http.StatusOK, res)
				default:
					writeJSON(w, http.StatusAccepted, res)
				}
			})
		}
		mux.HandleFunc("POST /"+o.path+"/add", func(w http.ResponseWriter, r *http.Request) {
			if !s.authorized(r) {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "unauthorized"})
				return
			}
			dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
			dec.DisallowUnknownFields()
			var req addRequest
			if err := dec.Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"code": "request.malformed"})
				return
			}
			if err := o.admit(r.Context(), s.registry, req.Leaf, req.Countersign); err != nil {
				if c := code(err); c != "" {
					writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"code": c})
					return
				}
				s.log.Error("admission", "origin", o.name, "err", err)
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "unavailable"})
				return
			}
			res, err := o.appendOnce(r.Context(), req.Leaf)
			switch {
			case errors.Is(err, errClaimed):
				writeJSON(w, http.StatusConflict, map[string]string{"code": "leaf.duplicate"})
			case errors.Is(err, tessera.ErrPushback):
				w.Header().Set("Retry-After", "1")
				writeJSON(w, http.StatusTooManyRequests, map[string]string{"code": "pushback"})
			case err != nil:
				s.log.Error("append", "origin", o.name, "err", err)
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "unavailable"})
			default:
				writeJSON(w, http.StatusOK, res)
			}
		})
	}
	return mux
}

// anchorTarget is the anchor target of o, or nil when o does not anchor.
func (s *server) anchorTarget(o *origin) *anchorTarget {
	if s.anchor == nil {
		return nil
	}
	return s.anchor.targets[o.name]
}

// tilePath matches the c2sp.org/tlog-tiles resources under an origin, and the
// co-logged checkpoint bodies and their Sigsum proofs, which never change either.
var tilePath = regexp.MustCompile(`^(tile/(\d{1,2}|entries)(/x\d{3})*/\d{3}(\.p/\d{1,3})?|sigsum/\d{1,20}\.(msg|proof))$`)

// public serves the tlog-tiles resources of every origin read-only, with the
// cache headers of Tessera's POSIX server, each origin's witness policy, and
// each origin's size at /health.
func (s *server) public() http.Handler {
	mux := http.NewServeMux()
	for _, o := range s.origins {
		mux.HandleFunc("GET /"+o.path+"/", func(w http.ResponseWriter, r *http.Request) {
			rel := strings.TrimPrefix(r.URL.Path, "/"+o.path+"/")
			cache := "public, max-age=31536000, immutable"
			switch {
			case rel == "policy":
				w.Header().Set("Cache-Control", "no-cache")
				w.Header().Set("Access-Control-Allow-Origin", "*")
				w.Header().Set("Content-Type", "text/plain; charset=utf-8")
				_, _ = w.Write(o.policy)
				return
			case rel == "checkpoint":
				cache = "no-cache"
			case !tilePath.MatchString(rel):
				http.NotFound(w, r)
				return
			}
			f, err := os.Open(filepath.Join(o.dir, filepath.FromSlash(rel)))
			if err != nil {
				w.Header().Set("Cache-Control", "no-store")
				http.NotFound(w, r)
				return
			}
			defer f.Close()
			st, err := f.Stat()
			if err != nil || st.IsDir() {
				w.Header().Set("Cache-Control", "no-store")
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Cache-Control", cache)
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Content-Type", "application/octet-stream")
			if rel == "checkpoint" {
				body, err := io.ReadAll(f)
				if err != nil {
					http.Error(w, "", http.StatusServiceUnavailable)
					return
				}
				sum := sha256.Sum256(body)
				w.Header().Set("Content-Type", "text/plain; charset=utf-8")
				w.Header().Set("ETag", `"`+hex.EncodeToString(sum[:])+`"`)
				http.ServeContent(w, r, "", st.ModTime(), bytes.NewReader(body))
				return
			}
			http.ServeContent(w, r, "", st.ModTime(), f)
		})
	}
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		type health struct {
			Origin string `json:"origin"`
			Size   int64  `json:"size"`
			// AnchoredSize is the latest anchored size, for an origin that anchors.
			AnchoredSize *uint64 `json:"anchoredSize,omitempty"`
		}
		out := []health{}
		for _, o := range s.origins {
			n, err := o.size(r.Context())
			if err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "unavailable"})
				return
			}
			h := health{Origin: o.name, Size: n}
			if t := s.anchorTarget(o); t != nil {
				a := t.anchored.Load()
				h.AnchoredSize = &a
			}
			out = append(out, h)
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]any{"origins": out})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
