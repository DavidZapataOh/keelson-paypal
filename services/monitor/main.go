// Command monitor follows the Keelson Alibi logs and checks every checkpoint's
// signatures and witness quorum, the consistency of every pair of checkpoints
// it sees, and the format and inclusion of every leaf, against keys and
// policies pinned in its own binary.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
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
	hc := &http.Client{Timeout: 10 * time.Second}
	events := make(chan Event, 64)
	for _, o := range cfg.Origins {
		go Follow(ctx, o, st, cfg.Poll, cfg.Sigsum, hc, events, logger)
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case e := <-events:
			if e.Report != nil {
				logger.Info("checkpoint", "origin", e.Report.Origin, "size", e.Report.Size)
			}
		}
	}
}
