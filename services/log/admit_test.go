package main

import (
	"context"
	"encoding/base64"
	"math/big"
	"net/http"
	"strings"
	"testing"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
)

func TestAdmissionRefusesWhatTheTEEsDidNotSign(t *testing.T) {
	vectors, negatives := loadVectors(t)
	allow, deny, degraded := vectors["allow"], vectors["deny"], vectors["degraded"]
	db, dbURL := testDB(t)
	l := startLog(t, newTestKeys(t), t.TempDir(), db, dbURL)

	twoOfTwo := func() {
		activate(t, db, teeTDX, *allow.Signers["tdx"], *allow.Measurements["tdx"])
		activate(t, db, teeNitro, *allow.Signers["nitro"], *allow.Measurements["nitro"])
	}
	tdxOnly := func() {
		activate(t, db, teeTDX, *degraded.Signers["tdx"], *degraded.Measurements["tdx"])
	}
	purchase(t, db, alibiID(t, allow.Leaf), ptr("2of2"))
	purchase(t, db, alibiID(t, deny.Leaf), ptr("2of2"))
	purchase(t, db, alibiID(t, degraded.Leaf), ptr("degraded"))

	b64 := base64.RawURLEncoding.EncodeToString
	sigs := func(m map[string]any) []any { return m["tee_sigs"].([]any) }
	meas := func(m map[string]any) []any { return m["measurements"].([]any) }
	highS := func(sig string) string {
		b, _ := base64.RawURLEncoding.DecodeString(sig)
		s := new(big.Int).SetBytes(b[32:64])
		new(big.Int).Sub(secp256k1.S256().N, s).FillBytes(b[32:64])
		b[64] = 55 - b[64]
		return b64(b)
	}
	flip := func(field string) func(m map[string]any) {
		return func(m map[string]any) {
			b, _ := base64.RawURLEncoding.DecodeString(m[field].(string))
			b[0] ^= 1
			m[field] = b64(b)
		}
	}

	type tc struct {
		name  string
		setup func()
		path  string
		leaf  []byte
		v     vector
		code  string
	}
	cases := []tc{}
	for _, n := range negatives {
		cases = append(cases, tc{"leaf: " + n.Name, twoOfTwo, sandbox, n.Leaf, allow, n.Code})
	}
	cartChanged := allow
	cartChanged.Countersign.CartHash[0] ^= 1
	cases = append(cases,
		tc{"the countersign's cart hash changed", twoOfTwo, sandbox, allow.Leaf, cartChanged, "countersign.digest"},
		tc{"the leaf's cart hash changed", twoOfTwo, sandbox, rewrite(t, allow.Leaf, flip("cart_hash")), allow, "countersign.fields"},
		tc{"the leaf's eval hash changed", twoOfTwo, sandbox, rewrite(t, allow.Leaf, flip("eval_hash")), allow, "countersign.fields"},
		tc{"the leaf's evidence root changed", twoOfTwo, sandbox, rewrite(t, allow.Leaf, flip("evidence_root")), allow, "countersign.fields"},
		tc{"the leaf's digest is not the message's", twoOfTwo, sandbox, rewrite(t, allow.Leaf, flip("countersign_digest")), allow, "countersign.digest"},
		tc{"a deny leaf with the allow message", twoOfTwo, sandbox, deny.Leaf, allow, "countersign.digest"},
		tc{"a sandbox leaf to the live origin", twoOfTwo, "alibi-live/2026-1", allow.Leaf, allow, "countersign.digest"},
		tc{"an unregistered nitro signer", func() { twoOfTwo(); revoke(t, db, *allow.Signers["nitro"]) }, sandbox, allow.Leaf, allow, "countersign.signer"},
		tc{"an expired tdx signer", func() {
			twoOfTwo()
			_, _ = db.Exec(context.Background(), `update tee_signers set expires_at = now() - interval '1 second' where tee_kind = 1`)
		}, sandbox, allow.Leaf, allow, "countersign.signer"},
		tc{"a signer that has not attested for three hours", func() {
			twoOfTwo()
			_, _ = db.Exec(context.Background(), `update tee_signers set verified_at = now() - interval '3 hours' where tee_kind = 2`)
		}, sandbox, allow.Leaf, allow, "countersign.signer"},
		tc{"two signatures from the same leg", twoOfTwo, sandbox, rewrite(t, allow.Leaf, func(m map[string]any) {
			m["tee_sigs"] = []any{sigs(m)[0], sigs(m)[0]}
		}), allow, "countersign.signer"},
		tc{"the legs swapped", twoOfTwo, sandbox, rewrite(t, allow.Leaf, func(m map[string]any) {
			m["tee_sigs"] = []any{sigs(m)[1], sigs(m)[0]}
			m["measurements"] = []any{meas(m)[1], meas(m)[0]}
		}), allow, "countersign.signer"},
		tc{"a high-S signature", twoOfTwo, sandbox, rewrite(t, allow.Leaf, func(m map[string]any) {
			m["tee_sigs"] = []any{highS(sigs(m)[0].(string)), sigs(m)[1]}
		}), allow, "countersign.signature"},
		tc{"v is 29", twoOfTwo, sandbox, rewrite(t, allow.Leaf, func(m map[string]any) {
			b, _ := base64.RawURLEncoding.DecodeString(sigs(m)[0].(string))
			b[64] = 29
			m["tee_sigs"] = []any{b64(b), sigs(m)[1]}
		}), allow, "countersign.signature"},
		tc{"the nitro measurement differs from the registered one", func() {
			twoOfTwo()
			activate(t, db, teeNitro, *allow.Signers["nitro"], "nitro:"+strings.Repeat("0", 62)+"ff")
		}, sandbox, allow.Leaf, allow, "countersign.measurement"},

		tc{"degraded: the allow leaf with only its nitro signature", twoOfTwo, sandbox, rewrite(t, allow.Leaf, func(m map[string]any) {
			m["mode"] = "degraded"
			m["tee_sigs"] = []any{sigs(m)[1]}
			m["measurements"] = []any{meas(m)[1]}
		}), allow, "countersign.signer"},
		tc{"degraded: the tdx signer revoked", func() { tdxOnly(); revoke(t, db, *degraded.Signers["tdx"]) }, sandbox, degraded.Leaf, degraded, "countersign.signer"},
		tc{"degraded: naming the nitro measurement", tdxOnly, sandbox, rewrite(t, degraded.Leaf, func(m map[string]any) {
			m["measurements"] = []any{meas(rewriteMap(t, allow.Leaf))[1]}
		}), degraded, "countersign.measurement"},
		tc{"degraded: relabelled 2of2", tdxOnly, sandbox, rewrite(t, degraded.Leaf, func(m map[string]any) { m["mode"] = "2of2" }), degraded, "leaf.mode"},
		tc{"the allow leaf relabelled degraded with both signatures", twoOfTwo, sandbox, rewrite(t, allow.Leaf, func(m map[string]any) { m["mode"] = "degraded" }), allow, "leaf.mode"},
		tc{"degraded: the purchase was countersigned 2of2", func() {
			tdxOnly()
			purchase(t, db, alibiID(t, degraded.Leaf), ptr("2of2"))
		}, sandbox, degraded.Leaf, degraded, "countersign.mode"},
		tc{"2of2: the purchase was countersigned degraded", func() {
			twoOfTwo()
			purchase(t, db, alibiID(t, allow.Leaf), ptr("degraded"))
		}, sandbox, allow.Leaf, allow, "countersign.mode"},
		tc{"2of2: the purchase has no mode", func() {
			twoOfTwo()
			purchase(t, db, alibiID(t, allow.Leaf), nil)
		}, sandbox, allow.Leaf, allow, "countersign.mode"},
	)

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			c.setup()
			before := nextIndex(t, l, c.path)
			status, body := l.add(t, c.path, testToken, c.leaf, c.v.Countersign)
			if status != http.StatusUnprocessableEntity || body["code"] != c.code {
				t.Fatalf("got %d %v, want 422 %s", status, body, c.code)
			}
			if after := nextIndex(t, l, c.path); after != before {
				t.Fatalf("the log grew from %d to %d", before, after)
			}
		})
	}
}

func rewriteMap(t testing.TB, leaf []byte) map[string]any {
	var out map[string]any
	rewrite(t, leaf, func(m map[string]any) { out = m })
	return out
}

func nextIndex(t testing.TB, l *testLog, path string) uint64 {
	t.Helper()
	n, err := l.origin(path).reader.NextIndex(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return n
}
