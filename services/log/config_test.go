package main

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestConfigRefusesTheHashOfAnEmptyToken(t *testing.T) {
	keys := newTestKeys(t)
	base := keys.getenv(t.TempDir(), "postgres://localhost/keelson")
	empty := sha256.Sum256(nil)
	getenv := func(k string) string {
		if k == "LOG_WRITE_TOKEN_SHA256" {
			return hex.EncodeToString(empty[:])
		}
		return base(k)
	}
	if _, err := loadConfig(getenv); err == nil {
		t.Fatal("a write token hash of the empty string was accepted")
	}
	if _, err := loadConfig(base); err != nil {
		t.Fatal(err)
	}
}

func TestServersHaveTimeouts(t *testing.T) {
	for _, srv := range newServers(&config{PublicAddr: ":0", PrivateAddr: ":0"}, &server{}) {
		if srv.ReadTimeout == 0 || srv.WriteTimeout <= awaitTimeout || srv.IdleTimeout == 0 || srv.ReadHeaderTimeout == 0 {
			t.Fatalf("%s: %+v", srv.Addr, srv)
		}
	}
}
