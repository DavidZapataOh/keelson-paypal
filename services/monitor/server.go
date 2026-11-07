package main

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"
)

const (
	// maxGossipBytes bounds a gossiped checkpoint.
	maxGossipBytes = 16 << 10
	// gossipPerMinute is how many checkpoints one client may gossip a minute.
	gossipPerMinute = 10
)

// monitor serves what the followers verified and checks gossiped checkpoints.
type monitor struct {
	cfg     *config
	st      *State
	eqs     *equivocations
	hc      *http.Client
	limiter *rateLimiter
	log     *slog.Logger
	// page is the public page, if served.
	page *page
	// gossipMu serializes the checks of gossiped checkpoints.
	gossipMu sync.Mutex
}

func newMonitor(cfg *config, st *State, eqs *equivocations, hc *http.Client, log *slog.Logger) *monitor {
	return &monitor{cfg: cfg, st: st, eqs: eqs, hc: hc, limiter: newRateLimiter(gossipPerMinute, time.Minute), log: log}
}

// Checks reports which checks run.
type Checks struct {
	TEESigners string `json:"teeSigners"`
	Anchors    string `json:"anchors"`
}

// FullReport is the monitor's whole view, served at /report.
type FullReport struct {
	Origins       []Report              `json:"origins"`
	Equivocations []EquivocationSummary `json:"equivocations"`
	Checks        Checks                `json:"checks"`
}

func (m *monitor) report() FullReport {
	r := FullReport{
		Equivocations: m.eqs.list(),
		// The signer registry and the anchor contract are not deployed yet.
		Checks: Checks{TEESigners: "not-enabled", Anchors: "not-enabled"},
	}
	for _, o := range m.cfg.Origins {
		r.Origins = append(r.Origins, buildReport(o, m.st))
	}
	return r
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// clientIP is the address gossip is rate limited by: the header the proxy in
// front sets, if configured, or the connection's address.
func (m *monitor) clientIP(r *http.Request) string {
	if h := m.cfg.ClientIPHeader; h != "" {
		if ip := r.Header.Get(h); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (m *monitor) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /report", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, m.report())
	})
	mux.HandleFunc("GET /checkpoints/{origin...}", func(w http.ResponseWriter, r *http.Request) {
		o := m.originNamed(r.PathValue("origin"))
		if o == nil || o == m.cfg.Conformance {
			http.NotFound(w, r)
			return
		}
		s := m.st.Get(o.Name)
		if len(s.Checkpoint) == 0 {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		_, _ = w.Write(s.Checkpoint)
	})
	mux.HandleFunc("GET /equivocations", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, m.eqs.list())
	})
	mux.HandleFunc("GET /equivocations/{id}", func(w http.ResponseWriter, r *http.Request) {
		e, ok := m.eqs.get(r.PathValue("id"))
		if !ok {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusOK, e)
	})
	mux.HandleFunc("POST /gossip", func(w http.ResponseWriter, r *http.Request) {
		if !m.limiter.allow(m.clientIP(r)) {
			w.Header().Set("Retry-After", "60")
			writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many checkpoints"})
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxGossipBytes))
		if err != nil {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "the checkpoint is too large"})
			return
		}
		status, e, err := m.gossip(r.Context(), body)
		switch {
		case errors.Is(err, errGossipRejected):
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
		case err != nil:
			m.log.Error("gossip", "err", err)
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "the log could not be read"})
		case e != nil:
			writeJSON(w, http.StatusConflict, map[string]string{"equivocation": e.ID})
		default:
			writeJSON(w, http.StatusOK, map[string]string{"status": status})
		}
	})
	if m.page != nil {
		m.page.register(mux, m.cfg)
	}
	return mux
}
