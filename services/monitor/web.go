package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/url"
	"slices"
	"strings"
)

// web holds the public page. verifier.wasm and wasm_exec.js are built into
// web/ before the monitor is compiled (see the Dockerfile).
//
//go:embed web
var webFS embed.FS

// page serves the public page and the files it loads.
type page struct {
	files    fs.FS
	wasmName string
	wasm     []byte
	wasmGzip []byte
	config   []byte
	csp      string
}

// pageConfig tells the page where each log is and which policy pins it.
type pageConfig struct {
	Wasm    string       `json:"wasm"`
	Origins []pageOrigin `json:"origins"`
}

type pageOrigin struct {
	Name   string `json:"name"`
	URL    string `json:"url"`
	Policy string `json:"policy"`
}

func newPage(cfg *config) (*page, error) {
	files, err := fs.Sub(webFS, "web")
	if err != nil {
		return nil, err
	}
	p := &page{files: files}
	p.wasm, err = fs.ReadFile(files, "verifier.wasm")
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if p.wasm != nil {
		sum := sha256.Sum256(p.wasm)
		p.wasmName = "verifier." + hex.EncodeToString(sum[:8]) + ".wasm"
		var b bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&b, gzip.BestCompression)
		if _, err := zw.Write(p.wasm); err != nil {
			return nil, err
		}
		if err := zw.Close(); err != nil {
			return nil, err
		}
		p.wasmGzip = b.Bytes()
	}
	pc := pageConfig{Wasm: p.wasmName}
	connect := []string{"'self'"}
	for _, o := range cfg.Origins {
		pc.Origins = append(pc.Origins, pageOrigin{Name: o.Name, URL: o.URL.String(), Policy: "policy/" + o.Name})
		logOrigin := (&url.URL{Scheme: o.URL.Scheme, Host: o.URL.Host}).String()
		if !slices.Contains(connect, logOrigin) {
			connect = append(connect, logOrigin)
		}
	}
	if p.config, err = json.Marshal(pc); err != nil {
		return nil, err
	}
	p.csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; " +
		"connect-src " + strings.Join(connect, " ") + "; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
	return p, nil
}

func (p *page) register(mux *http.ServeMux, cfg *config) {
	static := func(name, contentType string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			b, err := fs.ReadFile(p.files, name)
			if err != nil {
				http.NotFound(w, r)
				return
			}
			p.headers(w, contentType, "no-cache")
			_, _ = w.Write(b)
		}
	}
	mux.HandleFunc("GET /{$}", static("index.html", "text/html; charset=utf-8"))
	mux.HandleFunc("GET /app.js", static("app.js", "text/javascript; charset=utf-8"))
	mux.HandleFunc("GET /style.css", static("style.css", "text/css; charset=utf-8"))
	mux.HandleFunc("GET /wasm_exec.js", static("wasm_exec.js", "text/javascript; charset=utf-8"))
	mux.HandleFunc("GET /config.json", func(w http.ResponseWriter, r *http.Request) {
		p.headers(w, "application/json", "no-cache")
		_, _ = w.Write(p.config)
	})
	mux.HandleFunc("GET /policy/{origin...}", func(w http.ResponseWriter, r *http.Request) {
		for _, o := range cfg.Origins {
			if o.Name == r.PathValue("origin") {
				p.headers(w, "text/plain; charset=utf-8", "no-cache")
				_, _ = w.Write(o.PolicyText)
				return
			}
		}
		http.NotFound(w, r)
	})
	if p.wasmName != "" {
		mux.HandleFunc("GET /"+p.wasmName, func(w http.ResponseWriter, r *http.Request) {
			p.headers(w, "application/wasm", "public, max-age=31536000, immutable")
			w.Header().Set("Vary", "Accept-Encoding")
			if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
				w.Header().Set("Content-Encoding", "gzip")
				_, _ = w.Write(p.wasmGzip)
				return
			}
			_, _ = w.Write(p.wasm)
		})
	}
}

func (p *page) headers(w http.ResponseWriter, contentType, cache string) {
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("Cache-Control", cache)
	h.Set("Content-Security-Policy", p.csp)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
}
