package main

import (
	"bytes"
	"context"
	"crypto/mldsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"filippo.io/torchwood"
	"github.com/DavidZapataOh/keelson-paypal/internal/alibilog"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/mod/sumdb/note"
)

const testToken = "a-write-token-for-tests-only-0123456789"

type vector struct {
	Name         string               `json:"name"`
	Mode         string               `json:"mode"`
	Leaf         []byte               `json:"leaf"`
	LeafHash     string               `json:"leafHash"`
	Countersign  alibilog.Countersign `json:"countersign"`
	Signers      map[string]*string   `json:"signers"`
	Measurements map[string]*string   `json:"measurements"`
}

type negative struct {
	Name string `json:"name"`
	Leaf []byte `json:"leaf"`
	Code string `json:"code"`
}

func loadVectors(t testing.TB) (map[string]vector, []negative) {
	t.Helper()
	raw, err := os.ReadFile("../../packages/log/test/vectors/leaf.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Positive []vector   `json:"positive"`
		Negative []negative `json:"negative"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	out := map[string]vector{}
	for _, p := range v.Positive {
		out[p.Name] = p
	}
	return out, v.Negative
}

// testDB creates a fresh database with the API's migrations applied.
func testDB(t testing.TB) (*pgxpool.Pool, string) {
	t.Helper()
	ctx := context.Background()
	base := os.Getenv("DATABASE_URL")
	if base == "" {
		base = "postgres://postgres:keelson@localhost:5432/keelson"
	}
	admin, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	name := fmt.Sprintf("keelson_log_test_%d_%x", os.Getpid(), randBytes(4))
	if _, err := admin.Exec(ctx, "create database "+name); err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(base)
	u.Path = "/" + name
	db, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		db.Close()
		c, err := pgx.Connect(context.Background(), base)
		if err == nil {
			_, _ = c.Exec(context.Background(), "drop database "+name+" with (force)")
			c.Close(context.Background())
		}
	})
	migrate(t, db)
	return db, u.String()
}

// migrate applies the drizzle migrations in journal order.
func migrate(t testing.TB, db *pgxpool.Pool) {
	t.Helper()
	dir := "../../packages/db/drizzle"
	raw, err := os.ReadFile(filepath.Join(dir, "meta", "_journal.json"))
	if err != nil {
		t.Fatal(err)
	}
	var journal struct {
		Entries []struct {
			Tag string `json:"tag"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(raw, &journal); err != nil {
		t.Fatal(err)
	}
	for _, e := range journal.Entries {
		sql, err := os.ReadFile(filepath.Join(dir, e.Tag+".sql"))
		if err != nil {
			t.Fatal(err)
		}
		for _, stmt := range strings.Split(string(sql), "--> statement-breakpoint") {
			if strings.TrimSpace(stmt) == "" {
				continue
			}
			if _, err := db.Exec(context.Background(), stmt); err != nil {
				t.Fatalf("%s: %v", e.Tag, err)
			}
		}
	}
}

func randBytes(n int) []byte {
	b := make([]byte, n)
	rand.Read(b)
	return b
}

func addr(t testing.TB, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	if err != nil || len(b) != 20 {
		t.Fatalf("bad address %q", s)
	}
	return b
}

// activate makes address the one active signer of its TEE kind.
func activate(t testing.TB, db *pgxpool.Pool, kind int, address, measurement string) {
	t.Helper()
	ctx := context.Background()
	a := addr(t, address)
	if _, err := db.Exec(ctx, `update tee_signers set revoked_at = now(), revoked_reason = 'superseded'
		where tee_kind = $1 and revoked_at is null and address <> $2`, kind, a); err != nil {
		t.Fatal(err)
	}
	// Registered before any captured countersign was issued.
	if _, err := db.Exec(ctx, `insert into tee_signers (address, tee_kind, measurement, binding, attestation, registered_at, expires_at)
		values ($1, $2, $3, '{}', '{}', '2026-01-01T00:00:00Z', now() + interval '1 hour')
		on conflict (address) do update set tee_kind = excluded.tee_kind, measurement = excluded.measurement,
		registered_at = excluded.registered_at, verified_at = now(), expires_at = excluded.expires_at,
		revoked_at = null, revoked_reason = null`,
		a, kind, measurement); err != nil {
		t.Fatal(err)
	}
}

func revoke(t testing.TB, db *pgxpool.Pool, address string) {
	t.Helper()
	revokeAs(t, db, address, "contradiction")
}

func revokeAs(t testing.TB, db *pgxpool.Pool, address, reason string) {
	t.Helper()
	if _, err := db.Exec(context.Background(),
		`update tee_signers set revoked_at = now(), revoked_reason = $2 where address = $1`, addr(t, address), reason); err != nil {
		t.Fatal(err)
	}
}

// purchase records a purchase with the countersign mode the API would have set.
func purchase(t testing.TB, db *pgxpool.Pool, id string, mode *string) {
	t.Helper()
	ctx := context.Background()
	for _, q := range []string{
		`insert into "user" (id, name, email) values ('u_log_test', 'Log Test', 'log-test@keelson.finance') on conflict do nothing`,
		`insert into operators (agent_id, chain_id, agent_registry, name, cnf_jwk) values (42, 421614, 'eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e', 'Log Test', '{}') on conflict do nothing`,
		`insert into mandates (id, user_id, operator_agent_id, currency, max_minor, remaining_minor, merchant_ids, expires_at)
		 values ('01M6T2S5CDQGMQX1MR9ZTB0000', 'u_log_test', 42, 'USD', 100000, 100000, '{}', now() + interval '1 day')
		 on conflict do nothing`,
	} {
		if _, err := db.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(ctx, `insert into purchases (id, mandate_id, merchant_id, currency, amount_minor, cart_hash, countersign_mode)
		values ($1, '01M6T2S5CDQGMQX1MR9ZTB0000', 'mrc_runfast', 'USD', 9400, $2, $3)
		on conflict (id) do update set countersign_mode = excluded.countersign_mode`,
		id, randBytes(32), mode); err != nil {
		t.Fatal(err)
	}
}

func ptr(s string) *string { return &s }

// issuedAt is the leaf's issued_at, as Postgres reads it.
func issuedAt(t testing.TB, leaf []byte) string {
	l, err := alibilog.Parse(leaf)
	if err != nil {
		t.Fatal(err)
	}
	return l.IssuedAt.Format(time.RFC3339)
}

func alibiID(t testing.TB, leaf []byte) string {
	l, err := alibilog.Parse(leaf)
	if err != nil {
		t.Fatal(err)
	}
	return l.AlibiID
}

// testKeys are fresh keys for both origins, as cmd/keygen makes them.
type testKeys struct {
	env       map[string]string
	policyDir string
	vkeys     map[string][2]string
	policy    map[string]torchwood.Policy
}

func newTestKeys(t testing.TB) testKeys {
	t.Helper()
	k := testKeys{env: map[string]string{}, policyDir: t.TempDir(), vkeys: map[string][2]string{}, policy: map[string]torchwood.Policy{}}
	for _, o := range originSpecs {
		skey, vkey, err := note.GenerateKey(rand.Reader, o.Name)
		if err != nil {
			t.Fatal(err)
		}
		seed := randBytes(32)
		sk, err := mldsa.NewPrivateKey(mldsa.MLDSA44(), seed)
		if err != nil {
			t.Fatal(err)
		}
		s, err := torchwood.NewCosignatureSigner(o.Name, sk)
		if err != nil {
			t.Fatal(err)
		}
		k.env["LOG_SIGNER_KEY_"+o.Env] = skey
		k.env["LOG_MLDSA_SEED_"+o.Env] = base64.StdEncoding.EncodeToString(seed)
		k.vkeys[o.Name] = [2]string{vkey, s.Verifier().String()}
		p, err := torchwood.ParsePolicy([]byte("log " + vkey + "\nlog " + s.Verifier().String() + "\nquorum none\n"))
		if err != nil {
			t.Fatal(err)
		}
		k.policy[o.Name] = p
		k.writePolicy(t, o, "log "+vkey+"\nlog "+s.Verifier().String()+"\nquorum none\n")
	}
	return k
}

// writePolicy sets the witness policy the log loads for o.
func (k testKeys) writePolicy(t testing.TB, o originSpec, policy string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(k.policyDir, o.policyFile()), []byte(policy), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (k testKeys) getenv(dataDir, dbURL string) func(string) string {
	sum := sha256.Sum256([]byte(testToken))
	env := map[string]string{
		"LOG_DATA_DIR":               dataDir,
		"LOG_POLICY_DIR":             k.policyDir,
		"DATABASE_URL":               dbURL,
		"KEELSON_VERIFYING_CONTRACT": "0x0000000000000000000000000000000000000000",
		"LOG_WRITE_TOKEN_SHA256":     hex.EncodeToString(sum[:]),
	}
	for key, v := range k.env {
		env[key] = v
	}
	return func(key string) string { return env[key] }
}

// testLog is the personality running in-process with both listeners.
type testLog struct {
	s       *server
	public  *httptest.Server
	private *httptest.Server
	db      *pgxpool.Pool
}

func startLog(t testing.TB, keys testKeys, dataDir string, db *pgxpool.Pool, dbURL string) *testLog {
	t.Helper()
	cfg, err := loadConfig(keys.getenv(dataDir, dbURL))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s := &server{registry: registry{db}, tokenHash: cfg.TokenHash, log: slog.New(slog.DiscardHandler)}
	for _, spec := range originSpecs {
		o, err := openOrigin(ctx, spec, cfg.originDir(spec), cfg.VerifyingContract, cfg.Signers[spec.Name], cfg.Policies[spec.Name])
		if err != nil {
			t.Fatal(err)
		}
		if seed, ok := cfg.ReceiptKeys[spec.Name]; ok {
			o.receipts = localReceipts{seed}
		}
		s.origins = append(s.origins, o)
	}
	if cfg.Sigsum != nil {
		if s.colog, err = newCoLogger(cfg.Sigsum, cfg.SigsumSigner, cfg.DataDir, s.log); err != nil {
			t.Fatal(err)
		}
	}
	l := &testLog{s: s, public: httptest.NewServer(s.public()), private: httptest.NewServer(s.private())}
	t.Cleanup(l.public.Close)
	t.Cleanup(l.private.Close)
	return l
}

const sandbox = "alibi/2026-1"

func (l *testLog) origin(path string) *origin {
	for _, o := range l.s.origins {
		if o.path == path {
			return o
		}
	}
	panic(path)
}

// add posts a leaf to the private listener of the origin at path.
func (l *testLog) add(t testing.TB, path, token string, leaf []byte, c alibilog.Countersign) (int, map[string]string) {
	t.Helper()
	body, err := json.Marshal(map[string]any{"leaf": leaf, "countersign": c})
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodPost, l.private.URL+"/"+path+"/add", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := map[string]string{}
	_ = json.Unmarshal(raw, &out)
	return res.StatusCode, out
}

// rewrite changes a leaf's body and re-encodes it canonically.
func rewrite(t testing.TB, leaf []byte, change func(m map[string]any)) []byte {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(leaf[len(alibilog.Prefix):], &m); err != nil {
		t.Fatal(err)
	}
	change(m)
	body, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return append([]byte(alibilog.Prefix), body...)
}

// logRoot holds the data directories of in-process logs. Tessera's appender writes checkpoints from goroutines that
// cancelling its context stops but does not join, so a test's own TempDir cleanup could race a last write; the root
// is removed once every test has finished.
var logRoot string

func TestMain(m *testing.M) {
	var err error
	if logRoot, err = os.MkdirTemp("", "keelson-log-test-"); err != nil {
		panic(err)
	}
	code := m.Run()
	_ = os.RemoveAll(logRoot)
	os.Exit(code)
}

// logDir is a fresh data directory for an in-process log.
func logDir(t testing.TB) string {
	t.Helper()
	dir, err := os.MkdirTemp(logRoot, "log-")
	if err != nil {
		t.Fatal(err)
	}
	return dir
}
