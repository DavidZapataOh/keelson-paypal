// Command monitor follows the Keelson Alibi logs and checks every checkpoint's
// signatures and witness quorum, the consistency of every pair of checkpoints
// it sees, and the format and inclusion of every leaf, against keys and
// policies pinned in its own binary. It checks checkpoints gossiped by anyone
// and publishes proofs of equivocation.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(logger); err != nil {
		logger.Error("exit", "err", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	st, err := openState(cfg.DataDir)
	if err != nil {
		return err
	}
	eqs, err := openEquivocations(filepath.Join(cfg.DataDir, "equivocations"))
	if err != nil {
		return err
	}
	hc := newLogClient()
	m := newMonitor(cfg, st, eqs, hc, logger)
	if m.page, err = newPage(cfg); err != nil {
		return err
	}

	events := make(chan Event, 64)
	for _, o := range cfg.Origins {
		go Follow(ctx, o, st, cfg.Poll, cfg.Sigsum, hc, events, logger)
	}
	go func() {
		for e := range events {
			switch {
			case e.Equivocation != nil:
				if _, err := m.recordEquivocation(e.Equivocation); err != nil {
					logger.Error("equivocation", "err", err)
				}
			case e.Report != nil:
				logger.Info("checkpoint", "origin", e.Report.Origin, "size", e.Report.Size)
			}
		}
	}()

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           m.handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	logger.Info("serving", "addr", cfg.Addr)
	select {
	case <-ctx.Done():
	case err = <-errc:
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
