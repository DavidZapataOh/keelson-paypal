package alibilog

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"github.com/fxamacker/cbor/v2"
	cose "github.com/veraison/go-cose"
)

type statementVector struct {
	Name   string `json:"name"`
	Inputs struct {
		AlibiID           string            `json:"alibi_id"`
		Countersign       map[string]string `json:"countersign"`
		ChainID           uint64            `json:"chain_id"`
		VerifyingContract string            `json:"verifying_contract"`
		Mode              string            `json:"mode"`
		Legs              []struct {
			Kind        string `json:"kind"`
			Signer      string `json:"signer"`
			Signature   string `json:"signature"`
			Measurement string `json:"measurement"`
		} `json:"legs"`
		PayRef string `json:"pay_ref"`
	} `json:"inputs"`
	ClaimsHex    string `json:"claims_hex"`
	ProtectedHex string `json:"protected_hex"`
	StatementHex string `json:"statement_hex"`
	LeafHashHex  string `json:"leaf_hash_hex"`
}

var purchaseVectors = []string{"allow-2of2", "deny-2of2", "allow-degraded", "card-2of2"}

func loadVector(t *testing.T, name string) statementVector {
	t.Helper()
	raw, err := os.ReadFile("testdata/statement-v2/" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	var v statementVector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestStatementVectors(t *testing.T) {
	for _, name := range purchaseVectors {
		v := loadVector(t, name)
		leaf := unhex(t, v.StatementHex)
		l, err := ParseStatement(leaf)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if l.Version != 2 || l.Kind != KindPurchase || l.AlibiID != v.Inputs.AlibiID || l.Mode != v.Inputs.Mode {
			t.Fatalf("%s: parsed %d %s %s %s", name, l.Version, l.Kind, l.AlibiID, l.Mode)
		}
		if len(l.TeeSigs) != len(v.Inputs.Legs) {
			t.Fatalf("%s: %d legs", name, len(l.TeeSigs))
		}
		for i, leg := range v.Inputs.Legs {
			if !bytes.Equal(l.TeeSigs[i][:], unhex(t, leg.Signature)) || !bytes.Equal(l.Measurements[i][:], unhex(t, leg.Measurement)) {
				t.Fatalf("%s: leg %d", name, i)
			}
		}
		if got := hex.EncodeToString(l.MandateHash[:]); "0x"+got != v.Inputs.Countersign["mandateHash"] {
			t.Fatalf("%s: mandate hash %s", name, got)
		}
		if l.AgentID.String() != v.Inputs.Countersign["agentId"] || l.Countersign.Amount != 100 {
			t.Fatalf("%s: agent %s amount %d", name, l.AgentID, l.Countersign.Amount)
		}
		if (v.Inputs.PayRef == "") != (l.PaypalRefCommit == [32]byte{}) {
			t.Fatalf("%s: pay ref", name)
		}
		signer := v.Inputs.Legs[len(v.Inputs.Legs)-1].Signer
		if "0x"+hex.EncodeToString(l.StatementSigner[:]) != strings.ToLower(signer) {
			t.Fatalf("%s: statement signer", name)
		}
		h := LeafHash(leaf)
		if hex.EncodeToString(h[:]) != v.LeafHashHex {
			t.Fatalf("%s: leaf hash", name)
		}

		var msg cose.Sign1Message
		if err := msg.UnmarshalCBOR(leaf); err != nil {
			t.Fatal(err)
		}
		if err := msg.Verify(nil, ES256KVerifier(l.StatementSigner)); err != nil {
			t.Fatalf("%s: go-cose verify: %v", name, err)
		}
	}
}

func TestParseAnyV1(t *testing.T) {
	for _, id := range []string{"01M6ZWZJHWRRHQEYNJAT7NMSV8", "01M6ZX07MFWDDDW4199FDJHWEG"} {
		raw, err := os.ReadFile("../../packages/alibi/test/fixtures/" + id + ".alibi")
		if err != nil {
			t.Fatal(err)
		}
		var b struct {
			Leaf string `json:"leaf"`
		}
		if err := json.Unmarshal(raw, &b); err != nil {
			t.Fatal(err)
		}
		leaf, err := base64.StdEncoding.DecodeString(b.Leaf)
		if err != nil {
			t.Fatal(err)
		}
		l, err := ParseAny(leaf)
		if err != nil {
			t.Fatalf("%s: %v", id, err)
		}
		if l.Version != 1 || l.Kind != KindPurchase || l.AlibiID != id {
			t.Fatalf("%s: version %d kind %s id %s", id, l.Version, l.Kind, l.AlibiID)
		}
	}
}

var testKeys = [2][]byte{bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)}

// signStatement signs a statement with a vector key: 0 is the tdx leg, 1 the nitro leg.
func signStatement(t *testing.T, protected []byte, unprotected map[int]any, payload []byte, key int) []byte {
	t.Helper()
	em, _ := cbor.CoreDetEncOptions().EncMode()
	tbs, err := em.Marshal([]any{"Signature1", protected, []byte{}, payload})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(tbs)
	compact := ecdsa.SignCompact(secp256k1.PrivKeyFromBytes(testKeys[key]), digest[:], false)
	out, err := em.Marshal(cbor.Tag{Number: 18, Content: []any{protected, unprotected, payload, compact[1:]}})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func editClaims(t *testing.T, v statementVector, edit func(map[int]any)) []byte {
	t.Helper()
	var m map[int]any
	if err := cbor.Unmarshal(unhex(t, v.ClaimsHex), &m); err != nil {
		t.Fatal(err)
	}
	edit(m)
	em, _ := cbor.CoreDetEncOptions().EncMode()
	out, err := em.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func withKid(t *testing.T, protected, kid []byte) []byte {
	t.Helper()
	var m map[int]any
	if err := cbor.Unmarshal(protected, &m); err != nil {
		t.Fatal(err)
	}
	m[4] = kid
	em, _ := cbor.CoreDetEncOptions().EncMode()
	out, err := em.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func leafCode(t *testing.T, leaf []byte) string {
	t.Helper()
	_, err := ParseStatement(leaf)
	var le *LeafError
	if errors.As(err, &le) {
		return le.Code
	}
	if err != nil {
		t.Fatalf("not a LeafError: %v", err)
	}
	return "ok"
}

func TestStatementRejects(t *testing.T) {
	two := loadVector(t, "allow-2of2")
	deg := loadVector(t, "allow-degraded")
	twoProt := unhex(t, two.ProtectedHex)
	degProt := unhex(t, deg.ProtectedHex)
	cases := []struct {
		name, want string
		leaf       []byte
	}{
		{"2of2 with one leg", "leaf.mode", signStatement(t, twoProt, map[int]any{}, editClaims(t, two, func(m map[int]any) {
			m[21] = m[21].([]any)[:1]
		}), 1)},
		{"2of2 signed by tdx", "leaf.signer", signStatement(t, withKid(t, twoProt, unhex(t, two.Inputs.Legs[0].Signer)), map[int]any{}, unhex(t, two.ClaimsHex), 0)},
		{"unprotected header", "leaf.unprotected", signStatement(t, twoProt, map[int]any{33: []byte{1}}, unhex(t, two.ClaimsHex), 1)},
		{"signatures over another digest", "leaf.digest", signStatement(t, degProt, map[int]any{}, editClaims(t, deg, func(m map[int]any) {
			m[8] = uint64(101)
		}), 0)},
		{"unknown claim", "leaf.unknown", signStatement(t, degProt, map[int]any{}, editClaims(t, deg, func(m map[int]any) {
			m[23] = uint64(0)
		}), 0)},
		{"non-preferred tag", "leaf.noncanonical", append([]byte{0xd8, 0x12}, unhex(t, deg.StatementHex)[1:]...)},
		{"too large", "leaf.size", bytes.Repeat([]byte{0xd2}, 1025)},
	}
	for _, c := range cases {
		if got := leafCode(t, c.leaf); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
}
