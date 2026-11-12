package alibilog

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestBridgeVectors(t *testing.T) {
	for name, id := range map[string]string{
		"bridge-2of2":     "01M6ZWZJHWRRHQEYNJAT7NMSV8",
		"bridge-degraded": "01M6ZX07MFWDDDW4199FDJHWEG",
	} {
		raw, err := os.ReadFile("testdata/statement-v2/" + name + ".json")
		if err != nil {
			t.Fatal(err)
		}
		var v struct {
			Inputs struct {
				Predecessor  string `json:"predecessor"`
				BridgeSigner string `json:"bridge_signer"`
				Mode         string `json:"mode"`
			} `json:"inputs"`
			StatementHex string `json:"statement_hex"`
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatal(err)
		}
		l, err := ParseStatement(unhex(t, v.StatementHex))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if l.Kind != KindBridge || l.AlibiID != id || l.Mode != v.Inputs.Mode || l.Predecessor == nil {
			t.Fatalf("%s: kind %s id %s mode %s", name, l.Kind, l.AlibiID, l.Mode)
		}
		if "0x"+hex.EncodeToString(l.StatementSigner[:]) != strings.ToLower(v.Inputs.BridgeSigner) {
			t.Fatalf("%s: signer", name)
		}
		fixture, err := os.ReadFile("../../packages/alibi/test/fixtures/" + id + ".alibi")
		if err != nil {
			t.Fatal(err)
		}
		var b struct {
			Leaf string `json:"leaf"`
		}
		_ = json.Unmarshal(fixture, &b)
		leaf, _ := base64.StdEncoding.DecodeString(b.Leaf)
		v1, err := Parse(leaf)
		if err != nil {
			t.Fatal(err)
		}
		if *l.Predecessor != LeafHash(leaf) || l.CountersignDigest != v1.CountersignDigest {
			t.Fatalf("%s: predecessor or facts differ from the v1 leaf", name)
		}
	}
}
