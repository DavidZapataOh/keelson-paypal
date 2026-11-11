//go:build live

package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestLiveRemoteSignerBinds reaches leg A over RA-TLS and pins its certificate
// only because an active TDX signer, read from the API's registry, bound it.
// It signs nothing: leg A's history of the Alibi origins is the real log's.
//
//	LOG_REMOTE_SIGNER_URL=https://<app id>-8443s.<gateway> LOG_SIGNER_VKEY_SANDBOX=... \
//	  KEELSON_TEE_TOKEN=... DATABASE_URL=... go test -tags live -run TestLiveRemoteSigner ./services/log/
func TestLiveRemoteSignerBinds(t *testing.T) {
	url, vkey := os.Getenv("LOG_REMOTE_SIGNER_URL"), os.Getenv("LOG_SIGNER_VKEY_SANDBOX")
	if url == "" || vkey == "" || os.Getenv("DATABASE_URL") == "" {
		t.Skip("LOG_REMOTE_SIGNER_URL, LOG_SIGNER_VKEY_SANDBOX and DATABASE_URL are not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s, err := newRemoteSigner(vkey, url, os.Getenv("KEELSON_TEE_TOKEN"), registry{db})
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if err := s.bind(ctx); err != nil {
		t.Fatal(err)
	}
	t.Logf("bound leg A's certificate in %v", time.Since(started))
	// A request over the pinned connection: a checkpoint of another origin is refused.
	res, err := s.do(ctx, "POST", "/v1/log/sign", []byte(`{"checkpoint":"log.keelson.finance/conformance/2026-1\n1\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n"}`))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 422 {
		t.Fatalf("leg A answered %d to a checkpoint of an origin it does not sign", res.StatusCode)
	}
}
