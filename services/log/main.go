// Command log is the Keelson Alibi log: a Tessera personality that appends only
// countersigned Alibi leaves and serves them as c2sp.org/tlog-tiles.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/mod/sumdb/note"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(log); err != nil {
		log.Error("exit", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	appendCtx, cancelAppends := context.WithCancel(context.Background())
	defer cancelAppends()

	db, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close()

	s := &server{registry: registry{db}, tokenHash: cfg.TokenHash, log: log}
	for _, spec := range originSpecs {
		signers := cfg.Signers[spec.Name]
		var remote *remoteSigner
		if vkey, ok := cfg.RemoteVkeys[spec.Name]; ok {
			if remote, err = newRemoteSigner(vkey, cfg.RemoteURL, cfg.TEEToken, s.registry); err != nil {
				return err
			}
			signers = append([]note.Signer{remote}, signers...)
		}
		o, err := openOrigin(appendCtx, spec, cfg.originDir(spec), cfg.VerifyingContract, signers, cfg.Policies[spec.Name])
		if err != nil {
			return err
		}
		if remote != nil {
			remote.setReader(o.reader.ReadTile)
		}
		s.origins = append(s.origins, o)
	}
	if cfg.Sigsum != nil {
		if s.colog, err = newCoLogger(cfg.Sigsum, cfg.SigsumSigner, cfg.DataDir, log); err != nil {
			return err
		}
		go s.colog.run(ctx, s.origins)
	}
	if cfg.Anchor != nil {
		if s.anchor, err = newAnchorer(cfg.Anchor, cfg.VerifyingContract, s.origins, s.registry, log); err != nil {
			return err
		}
		go s.anchor.run(ctx)
	}

	servers := newServers(cfg, s)
	errc := make(chan error, len(servers))
	for _, srv := range servers {
		go func() { errc <- srv.ListenAndServe() }()
	}
	log.Info("serving", "public", cfg.PublicAddr, "private", cfg.PrivateAddr)

	select {
	case <-ctx.Done():
	case err = <-errc:
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for _, srv := range servers {
		_ = srv.Shutdown(shutdownCtx)
	}
	// Every append that was answered is integrated and covered by a checkpoint.
	for _, o := range s.origins {
		if serr := o.shutdown(shutdownCtx); serr != nil {
			log.Error("shutdown", "origin", o.name, "err", serr)
		}
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// newServers returns the public and private listeners. An append may wait
// awaitTimeout for its checkpoint, so writes get longer than that.
func newServers(cfg *config, s *server) []*http.Server {
	srv := func(addr string, h http.Handler) *http.Server {
		return &http.Server{
			Addr:              addr,
			Handler:           h,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       10 * time.Second,
			WriteTimeout:      awaitTimeout + 5*time.Second,
			IdleTimeout:       2 * time.Minute,
		}
	}
	return []*http.Server{srv(cfg.PublicAddr, s.public()), srv(cfg.PrivateAddr, s.private())}
}
