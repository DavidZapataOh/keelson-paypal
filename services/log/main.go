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
		o, err := openOrigin(appendCtx, spec, cfg.originDir(spec), cfg.VerifyingContract, cfg.Signers[spec.Name])
		if err != nil {
			return err
		}
		s.origins = append(s.origins, o)
	}

	servers := []*http.Server{
		{Addr: cfg.PublicAddr, Handler: s.public(), ReadHeaderTimeout: 5 * time.Second},
		{Addr: cfg.PrivateAddr, Handler: s.private(), ReadHeaderTimeout: 5 * time.Second},
	}
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
