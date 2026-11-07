// Command keygen prints a new Ed25519 note key pair and ML-DSA-44 key pair for
// a log origin: the secrets as environment lines on stdout, the verifier keys
// to <dir>/<name>.vkey and <dir>/<name>.mldsa.vkey.
package main

import (
	"crypto/mldsa"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"filippo.io/torchwood"
	"golang.org/x/mod/sumdb/note"
)

func main() {
	origin := flag.String("origin", "", "log origin, e.g. log.keelson.finance/alibi/2026-1")
	env := flag.String("env", "", "suffix of the environment variables, e.g. SANDBOX")
	dir := flag.String("dir", "", "directory for the verifier keys")
	name := flag.String("name", "", "file name of the verifier keys")
	flag.Parse()
	if *origin == "" || *env == "" || *dir == "" || *name == "" {
		flag.Usage()
		os.Exit(2)
	}

	skey, vkey, err := note.GenerateKey(rand.Reader, *origin)
	if err != nil {
		log.Fatal(err)
	}
	seed := make([]byte, 32)
	rand.Read(seed)
	k, err := mldsa.NewPrivateKey(mldsa.MLDSA44(), seed)
	if err != nil {
		log.Fatal(err)
	}
	s, err := torchwood.NewCosignatureSigner(*origin, k)
	if err != nil {
		log.Fatal(err)
	}
	for file, v := range map[string]string{*name + ".vkey": vkey, *name + ".mldsa.vkey": s.Verifier().String()} {
		if err := os.WriteFile(filepath.Join(*dir, file), []byte(v+"\n"), 0o644); err != nil {
			log.Fatal(err)
		}
	}
	fmt.Printf("LOG_SIGNER_KEY_%s=%s\n", *env, skey)
	fmt.Printf("LOG_MLDSA_SEED_%s=%s\n", *env, base64.StdEncoding.EncodeToString(seed))
}
