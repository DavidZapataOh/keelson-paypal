package main

import (
	"cmp"
	"crypto/ecdsa"
	"crypto/mldsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"filippo.io/torchwood"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/transparency-dev/tessera"
	"golang.org/x/mod/sumdb/note"
	sigsumcrypto "sigsum.org/sigsum-go/pkg/crypto"
	"sigsum.org/sigsum-go/pkg/key"
	"sigsum.org/sigsum-go/pkg/policy"
	"sigsum.org/sigsum-go/pkg/submit"
)

// host is the public name every origin is served under.
const host = "log.keelson.finance"

// originSpec is one log. Each flow has its own origin, chain and keys.
type originSpec struct {
	Name    string
	ChainID uint64
	// Env is the suffix of the origin's key variables.
	Env string
}

var originSpecs = []originSpec{
	{Name: host + "/alibi/2026-1", ChainID: 421614, Env: "SANDBOX"},
	{Name: host + "/alibi-live/2026-1", ChainID: 42161, Env: "LIVE"},
}

// path is the origin without the host: the URL prefix its tiles are served under.
func (o originSpec) path() string { return strings.TrimPrefix(o.Name, host+"/") }

// policyFile is the name of the origin's witness policy file.
func (o originSpec) policyFile() string { return strings.ReplaceAll(o.path(), "/", "-") + ".policy" }

type config struct {
	DataDir           string
	PublicAddr        string
	PrivateAddr       string
	DatabaseURL       string
	VerifyingContract [20]byte
	TokenHash         [32]byte
	Signers           map[string][]note.Signer
	// Policies are the witness policies of each origin, in the Sigsum policy
	// format: the log keys, the witnesses and the quorum every checkpoint needs.
	Policies map[string][]byte
	// RemoteVkeys are the origins whose Ed25519 key leg A holds, with that key:
	// those origins are signed over RA-TLS at RemoteURL (LOG_SIGNER_VKEY_<env>,
	// LOG_REMOTE_SIGNER_URL), with the legs' bearer token.
	RemoteVkeys map[string]string
	RemoteURL   string
	TEEToken    string
	// Sigsum co-logs checkpoints when SIGSUM_SUBMIT_KEY is set.
	Sigsum       *submit.Config
	SigsumSigner sigsumcrypto.Signer
	// Anchor anchors checkpoints on-chain when ANCHOR_SUBMITTER_KEY is set.
	Anchor *anchorConfig
}

// anchorConfig is where and with what checkpoints are anchored: the
// CheckpointAnchor address (the same on every chain), the RPC of each chain
// anchors go to, in the order they are tried, the submitter key and the legs that sign them.
type anchorConfig struct {
	Address common.Address
	RPC     map[uint64][]string
	Key     *ecdsa.PrivateKey
	TEEA    string
	TEEB    string
	Token   string
}

func loadAnchorConfig(getenv func(string) string) (*anchorConfig, error) {
	k := getenv("ANCHOR_SUBMITTER_KEY")
	if k == "" {
		return nil, nil
	}
	key, err := crypto.HexToECDSA(strings.TrimPrefix(k, "0x"))
	if err != nil {
		return nil, errors.New("ANCHOR_SUBMITTER_KEY is not a secp256k1 private key")
	}
	addr := getenv("CHECKPOINT_ANCHOR_ADDRESS")
	if !common.IsHexAddress(addr) {
		return nil, errors.New("CHECKPOINT_ANCHOR_ADDRESS is not an address")
	}
	c := &anchorConfig{
		Address: common.HexToAddress(addr),
		RPC:     map[uint64][]string{},
		Key:     key,
		TEEA:    getenv("TEE_A_URL"),
		TEEB:    getenv("TEE_B_URL"),
		Token:   getenv("KEELSON_TEE_TOKEN"),
	}
	if c.TEEA == "" || c.TEEB == "" || c.Token == "" {
		return nil, errors.New("TEE_A_URL, TEE_B_URL and KEELSON_TEE_TOKEN are required with ANCHOR_SUBMITTER_KEY")
	}
	for chainID, name := range map[uint64]string{421614: "ARBITRUM_SEPOLIA_RPC_URL", 42161: "ARBITRUM_ONE_RPC_URL"} {
		if u := getenv(name); u != "" {
			c.RPC[chainID] = []string{u, publicRPC[chainID]}
		}
	}
	return c, nil
}

func loadConfig(getenv func(string) string) (*config, error) {
	c := &config{
		DataDir:     getenv("LOG_DATA_DIR"),
		PublicAddr:  ":" + cmp.Or(getenv("PORT"), "10000"),
		PrivateAddr: cmp.Or(getenv("LOG_PRIVATE_ADDR"), ":8081"),
		DatabaseURL: getenv("DATABASE_URL"),
		Signers:     map[string][]note.Signer{},
		RemoteVkeys: map[string]string{},
		RemoteURL:   getenv("LOG_REMOTE_SIGNER_URL"),
		TEEToken:    getenv("KEELSON_TEE_TOKEN"),
		Policies:    map[string][]byte{},
	}
	policyDir := getenv("LOG_POLICY_DIR")
	if c.DataDir == "" || c.DatabaseURL == "" || policyDir == "" {
		return nil, errors.New("LOG_DATA_DIR, LOG_POLICY_DIR and DATABASE_URL are required")
	}
	vc, err := hex.DecodeString(strings.TrimPrefix(getenv("KEELSON_VERIFYING_CONTRACT"), "0x"))
	if err != nil || len(vc) != 20 {
		return nil, errors.New("KEELSON_VERIFYING_CONTRACT is not an address")
	}
	copy(c.VerifyingContract[:], vc)
	th, err := hex.DecodeString(getenv("LOG_WRITE_TOKEN_SHA256"))
	if err != nil || len(th) != 32 {
		return nil, errors.New("LOG_WRITE_TOKEN_SHA256 is not a SHA-256 hex digest")
	}
	if [32]byte(th) == sha256.Sum256(nil) {
		return nil, errors.New("LOG_WRITE_TOKEN_SHA256 is the hash of an empty token")
	}
	copy(c.TokenHash[:], th)
	for _, o := range originSpecs {
		if vkey := getenv("LOG_SIGNER_VKEY_" + o.Env); vkey != "" {
			if c.RemoteURL == "" || c.TEEToken == "" {
				return nil, fmt.Errorf("%s: LOG_REMOTE_SIGNER_URL and KEELSON_TEE_TOKEN are required with LOG_SIGNER_VKEY_%s", o.Name, o.Env)
			}
			ml, err := mldsaSigner(o.Name, getenv("LOG_MLDSA_SEED_"+o.Env))
			if err != nil {
				return nil, fmt.Errorf("%s: %w", o.Name, err)
			}
			c.RemoteVkeys[o.Name] = vkey
			c.Signers[o.Name] = []note.Signer{ml}
		} else {
			s, err := originSigners(o.Name, getenv("LOG_SIGNER_KEY_"+o.Env), getenv("LOG_MLDSA_SEED_"+o.Env))
			if err != nil {
				return nil, fmt.Errorf("%s: %w", o.Name, err)
			}
			c.Signers[o.Name] = s
		}
		p, err := os.ReadFile(filepath.Join(policyDir, o.policyFile()))
		if err != nil {
			return nil, err
		}
		if _, err := tessera.NewWitnessGroupFromPolicy(p); err != nil {
			return nil, fmt.Errorf("%s: witness policy: %w", o.Name, err)
		}
		if _, err := torchwood.ParsePolicy(p); err != nil {
			return nil, fmt.Errorf("%s: witness policy: %w", o.Name, err)
		}
		c.Policies[o.Name] = p
	}
	if c.Anchor, err = loadAnchorConfig(getenv); err != nil {
		return nil, err
	}
	if k := getenv("SIGSUM_SUBMIT_KEY"); k != "" {
		signer, _, err := key.ParsePrivateKey(k)
		if err != nil {
			return nil, fmt.Errorf("SIGSUM_SUBMIT_KEY: %w", err)
		}
		p, err := policy.ReadPolicyFile(filepath.Join(policyDir, "sigsum-seasalp.policy"))
		if err != nil {
			return nil, err
		}
		c.SigsumSigner = signer
		c.Sigsum = &submit.Config{Domain: sigsumDomain, RateLimitSigner: signer, Policy: p, UserAgent: "keelson-log"}
	}
	return c, nil
}

// originSigners returns the Ed25519 note signer and the ML-DSA-44 signer of an
// origin. Both are named after the origin, as checkpoint signers must be.
func originSigners(origin, skey, seed64 string) ([]note.Signer, error) {
	ed, err := note.NewSigner(skey)
	if err != nil {
		return nil, fmt.Errorf("signer key: %w", err)
	}
	if ed.Name() != origin {
		return nil, fmt.Errorf("signer key is for %q", ed.Name())
	}
	ml, err := mldsaSigner(origin, seed64)
	if err != nil {
		return nil, err
	}
	return []note.Signer{ed, ml}, nil
}

// mldsaSigner returns the ML-DSA-44 signer of an origin, from its 32-byte seed.
func mldsaSigner(origin, seed64 string) (note.Signer, error) {
	seed, err := base64.StdEncoding.DecodeString(seed64)
	if err != nil || len(seed) != 32 {
		return nil, errors.New("ML-DSA seed is not 32 bytes of base64")
	}
	k, err := mldsa.NewPrivateKey(mldsa.MLDSA44(), seed)
	if err != nil {
		return nil, err
	}
	return torchwood.NewCosignatureSigner(origin, k)
}

func (c *config) originDir(o originSpec) string {
	return filepath.Join(c.DataDir, filepath.FromSlash(o.path()))
}
