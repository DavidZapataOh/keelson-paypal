package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/DavidZapataOh/keelson-paypal/internal/alibilog"
	"github.com/fxamacker/cbor/v2"
	"github.com/transparency-dev/merkle/proof"
	"github.com/transparency-dev/merkle/rfc6962"
	cose "github.com/veraison/go-cose"
)

type statementVector struct {
	Inputs struct {
		AlibiID           string          `json:"alibi_id"`
		Countersign       json.RawMessage `json:"countersign"`
		VerifyingContract string          `json:"verifying_contract"`
		Mode              string          `json:"mode"`
		BridgeSigner      string          `json:"bridge_signer"`
		Legs              []struct {
			Kind        string `json:"kind"`
			Signer      string `json:"signer"`
			Measurement string `json:"measurement"`
		} `json:"legs"`
	} `json:"inputs"`
	StatementHex string `json:"statement_hex"`
}

func loadStatement(t *testing.T, name string) (statementVector, []byte, alibilog.Countersign) {
	t.Helper()
	raw, err := os.ReadFile("../../internal/alibilog/testdata/statement-v2/" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	var v statementVector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	var c alibilog.Countersign
	if len(v.Inputs.Countersign) > 0 {
		if err := json.Unmarshal(v.Inputs.Countersign, &c); err != nil {
			t.Fatal(err)
		}
	}
	leaf, _ := hex.DecodeString(v.StatementHex)
	return v, leaf, c
}

// receiptKeyed starts a log whose origins sign receipts with a local key, as the conformance origin does.
func receiptKeyed(t *testing.T, contract string) (*testLog, ed25519.PublicKey) {
	t.Helper()
	db, dbURL := testDB(t)
	keys := newTestKeys(t)
	seed := randBytes(32)
	for _, o := range originSpecs {
		keys.env["LOG_RECEIPT_SEED_"+o.Env] = base64.StdEncoding.EncodeToString(seed)
	}
	keys.env["KEELSON_VERIFYING_CONTRACT"] = contract
	l := startLog(t, keys, logDir(t), db, dbURL)
	l.db = db
	return l, ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
}

func TestAppendsStatementLeavesWithAReceipt(t *testing.T) {
	first, _, _ := loadStatement(t, "allow-degraded")
	l, key := receiptKeyed(t, first.Inputs.VerifyingContract)
	for i, name := range []string{"allow-degraded", "allow-2of2"} {
		v, leaf, c := loadStatement(t, name)
		for _, leg := range v.Inputs.Legs {
			kind := map[string]int{"tdx": teeTDX, "nitro": teeNitro}[leg.Kind]
			activate(t, l.db, kind, leg.Signer, leg.Kind+":"+strings.TrimPrefix(leg.Measurement, "0x"))
		}
		purchase(t, l.db, v.Inputs.AlibiID, ptr(v.Inputs.Mode))
		status, res := l.add(t, sandbox, testToken, leaf, c)
		if status != http.StatusOK {
			t.Fatalf("%s: %d %v", name, status, res)
		}
		if i == 0 {
			// A one-leaf tree has an empty inclusion path, which RFC 9942 cannot carry.
			if res["receipt"] != "" {
				t.Fatalf("a receipt for a one-leaf tree")
			}
			continue
		}
		receipt, err := base64.StdEncoding.DecodeString(res["receipt"])
		if err != nil || len(receipt) == 0 {
			t.Fatalf("%s: no receipt in %v", name, res)
		}
		var msg cose.Sign1Message
		if err := msg.UnmarshalCBOR(receipt); err != nil {
			t.Fatal(err)
		}
		var tagged cbor.RawTag
		if err := cbor.Unmarshal(receipt, &tagged); err != nil {
			t.Fatal(err)
		}
		var body struct {
			_           struct{} `cbor:",toarray"`
			Protected   []byte
			Unprotected map[int]map[int][][]byte
			Payload     []byte
			Signature   []byte
		}
		if err := cbor.Unmarshal(tagged.Content, &body); err != nil {
			t.Fatal(err)
		}
		proofs := body.Unprotected
		var content struct {
			_     struct{} `cbor:",toarray"`
			Size  uint64
			Index uint64
			Path  [][]byte
		}
		if err := cbor.Unmarshal(proofs[headerVDP][inclusionProofLabel][0], &content); err != nil {
			t.Fatal(err)
		}
		if content.Size != 2 || content.Index != 1 {
			t.Fatalf("receipt for index %d of %d", content.Index, content.Size)
		}
		root, err := proof.RootFromInclusionProof(rfc6962.DefaultHasher, content.Index, content.Size, rfc6962.DefaultHasher.HashLeaf(leaf), content.Path)
		if err != nil {
			t.Fatal(err)
		}
		msg.Payload = root
		if err := msg.Verify(nil, ed25519Verifier(key)); err != nil {
			t.Fatalf("%s: the receipt does not verify: %v", name, err)
		}
	}
}

func TestRefusesStatementLeaves(t *testing.T) {
	v, leaf, c := loadStatement(t, "allow-2of2")
	l, _ := receiptKeyed(t, v.Inputs.VerifyingContract)
	for _, leg := range v.Inputs.Legs {
		kind := map[string]int{"tdx": teeTDX, "nitro": teeNitro}[leg.Kind]
		activate(t, l.db, kind, leg.Signer, leg.Kind+":"+strings.TrimPrefix(leg.Measurement, "0x"))
	}
	purchase(t, l.db, v.Inputs.AlibiID, ptr("2of2"))
	badSig := bytes.Clone(leaf)
	badSig[len(badSig)-1] ^= 1
	other := c
	other.Amount++
	for _, tc := range []struct {
		name string
		leaf []byte
		c    alibilog.Countersign
		code string
	}{
		{"a statement signature that does not verify", badSig, c, "leaf.signature"},
		{"a countersign other than the statement's", leaf, other, "countersign.digest"},
	} {
		status, res := l.add(t, sandbox, testToken, tc.leaf, tc.c)
		if status != http.StatusUnprocessableEntity || res["code"] != tc.code {
			t.Errorf("%s: %d %v, want %s", tc.name, status, res, tc.code)
		}
	}
	purchase(t, l.db, v.Inputs.AlibiID, ptr("degraded"))
	if status, res := l.add(t, sandbox, testToken, leaf, c); res["code"] != "countersign.mode" {
		t.Errorf("a 2of2 statement for a degraded purchase: %d %v", status, res)
	}
}

func TestServesTheReceiptKeys(t *testing.T) {
	l, key := receiptKeyed(t, "0x0000000000000000000000000000000000000000")
	res, err := http.Get(l.public.URL + "/.well-known/scitt-keys")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if ct := res.Header.Get("Content-Type"); ct != "application/cbor" {
		t.Fatalf("content type %q", ct)
	}
	body, _ := io.ReadAll(res.Body)
	var set []map[int]any
	if err := cbor.Unmarshal(body, &set); err != nil {
		t.Fatal(err)
	}
	kid := sha256.Sum256(key)
	found := false
	for _, k := range set {
		if bytes.Equal(k[-2].([]byte), key) && bytes.Equal(k[2].([]byte), kid[:]) && k[1] == uint64(1) && k[-1] == uint64(6) {
			found = true
		}
	}
	if !found {
		t.Fatalf("the key set %v does not hold the receipt key", set)
	}
}

func activateLegs(t *testing.T, l *testLog, v statementVector) {
	t.Helper()
	for _, leg := range v.Inputs.Legs {
		kind := map[string]int{"tdx": teeTDX, "nitro": teeNitro}[leg.Kind]
		activate(t, l.db, kind, leg.Signer, leg.Kind+":"+strings.TrimPrefix(leg.Measurement, "0x"))
	}
}

func TestAdmitsCardStatementsAfterTheirPurchase(t *testing.T) {
	v, purchaseLeaf, c := loadStatement(t, "card-2of2")
	l, _ := receiptKeyed(t, v.Inputs.VerifyingContract)
	activateLegs(t, l, v)
	purchase(t, l.db, v.Inputs.AlibiID, ptr("2of2"))
	_, approve, _ := loadStatement(t, "card-auth-approve")
	_, decline, _ := loadStatement(t, "card-auth-decline")
	_, settlement, _ := loadStatement(t, "card-settlement")

	if status, res := l.add(t, sandbox, testToken, approve, c); res["code"] != "card.parent" {
		t.Fatalf("a decision before its purchase: %d %v", status, res)
	}
	for _, step := range []struct {
		name string
		leaf []byte
	}{{"purchase", purchaseLeaf}, {"approve", approve}, {"decline", decline}, {"settlement", settlement}} {
		if status, res := l.add(t, sandbox, testToken, step.leaf, c); status != http.StatusOK {
			t.Fatalf("%s: %d %v", step.name, status, res)
		}
	}
	// The same bytes again are the same leaf; another settlement of the same transaction is not.
	if status, _ := l.add(t, sandbox, testToken, settlement, c); status != http.StatusOK {
		t.Fatalf("a retried settlement: %d", status)
	}
	other := bytes.Clone(settlement)
	other[len(other)-1] ^= 1
	if _, res := l.add(t, sandbox, testToken, other, c); res["code"] != "leaf.signature" {
		t.Fatalf("a re-signed settlement: %v", res)
	}
	foreign := c
	foreign.MandateHash[0] ^= 1
	_, decline2, _ := loadStatement(t, "card-auth-decline")
	if _, res := l.add(t, sandbox, testToken, decline2, foreign); res["code"] != "countersign.digest" {
		t.Fatalf("a decision under another countersign: %v", res)
	}
}

// v1Fixture is a real v1 Alibi's leaf, countersign and legs, from the verifier's fixtures.
func v1Fixture(t *testing.T, id string) ([]byte, alibilog.Countersign, []struct{ kind, signer, measurement string }) {
	t.Helper()
	raw, err := os.ReadFile("../../packages/alibi/test/fixtures/" + id + ".alibi")
	if err != nil {
		t.Fatal(err)
	}
	var b struct {
		Leaf string `json:"leaf"`
		Tee  struct {
			Countersign  json.RawMessage `json:"countersign"`
			Attestations []struct {
				Kind        string `json:"kind"`
				Signer      string `json:"signer"`
				Measurement string `json:"measurement"`
			} `json:"attestations"`
		} `json:"tee"`
	}
	if err := json.Unmarshal(raw, &b); err != nil {
		t.Fatal(err)
	}
	leaf, _ := base64.StdEncoding.DecodeString(b.Leaf)
	var c alibilog.Countersign
	if err := json.Unmarshal(b.Tee.Countersign, &c); err != nil {
		t.Fatal(err)
	}
	var legs []struct{ kind, signer, measurement string }
	for _, a := range b.Tee.Attestations {
		legs = append(legs, struct{ kind, signer, measurement string }{a.Kind, a.Signer, a.Measurement})
	}
	return leaf, c, legs
}

func TestAdmitsOneBridgePerV1Leaf(t *testing.T) {
	b, bridge, _ := loadStatement(t, "bridge-degraded")
	v1, c, legs := v1Fixture(t, b.Inputs.AlibiID)
	l, _ := receiptKeyed(t, b.Inputs.VerifyingContract)
	for _, leg := range legs {
		activate(t, l.db, map[string]int{"tdx": teeTDX, "nitro": teeNitro}[leg.kind], leg.signer, leg.measurement)
	}
	purchase(t, l.db, b.Inputs.AlibiID, ptr("degraded"))
	if _, res := l.add(t, sandbox, testToken, bridge, c); res["code"] != "bridge.parent" {
		t.Fatalf("a bridge before its v1 leaf: %v", res)
	}
	if status, res := l.add(t, sandbox, testToken, v1, c); status != http.StatusOK {
		t.Fatalf("v1 leaf: %d %v", status, res)
	}
	if _, res := l.add(t, sandbox, testToken, bridge, c); res["code"] != "bridge.signer" {
		t.Fatalf("a bridge by a signer that is not an active TDX signer: %v", res)
	}
	activate(t, l.db, teeTDX, b.Inputs.BridgeSigner, "tdx:"+strings.Repeat("ab", 32))
	if status, res := l.add(t, sandbox, testToken, bridge, c); status != http.StatusOK {
		t.Fatalf("bridge: %d %v", status, res)
	}
}
