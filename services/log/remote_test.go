package main

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
)

func TestRecoverBindingNamesTheSigner(t *testing.T) {
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	cert := sha256.Sum256([]byte("leaf certificate"))
	sig, err := crypto.Sign(crypto.Keccak256(append([]byte("keelson/ra-tls/v1"), cert[:]...)), key)
	if err != nil {
		t.Fatal(err)
	}
	sig[64] += 27
	got, err := recoverBinding(cert, "0x"+hex.EncodeToString(sig))
	if err != nil || got != crypto.PubkeyToAddress(key.PublicKey) {
		t.Fatalf("recovered %x, %v", got, err)
	}
	other := sha256.Sum256([]byte("another certificate"))
	if got, _ := recoverBinding(other, "0x"+hex.EncodeToString(sig)); got == crypto.PubkeyToAddress(key.PublicKey) {
		t.Fatal("a binding of another certificate recovers the same signer")
	}
	if _, err := recoverBinding(cert, "0x00"); err == nil {
		t.Fatal("a short signature recovers")
	}
}

func TestCheckpointSize(t *testing.T) {
	size, err := checkpointSize([]byte("log.keelson.finance/alibi/2026-1\n785\nUlmDsr9Nkuc11Ld6fRMEeFyrKi4fwqhQ3n0huRUBl40=\n"))
	if err != nil || size != 785 {
		t.Fatalf("size %d, %v", size, err)
	}
	if _, err := checkpointSize([]byte("origin\n")); err == nil {
		t.Fatal("a body without a size parses")
	}
}

func TestNewRemoteSignerReadsTheVkey(t *testing.T) {
	const vkey = "log.keelson.finance/alibi/2026-1+8553fcbd+ATEHrhTfdzkwLLgf9SZhMsIhsHzRmvpFnaBfgK0D10Id"
	s, err := newRemoteSigner(vkey, "https://leg-a.example/", "token", nil)
	if err != nil {
		t.Fatal(err)
	}
	if s.Name() != "log.keelson.finance/alibi/2026-1" || s.KeyHash() != 0x8553fcbd || len(s.public) != 32 {
		t.Fatalf("%s %x %d", s.Name(), s.KeyHash(), len(s.public))
	}
	if _, err := newRemoteSigner("log.keelson.finance/alibi/2026-1+8553fcbd+AAAA", "u", "t", nil); err == nil {
		t.Fatal("a malformed vkey is accepted")
	}
}
