package alibilog

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"testing"
)

func TestCardStatementVectors(t *testing.T) {
	for _, name := range []string{"card-auth-approve", "card-auth-decline", "card-settlement"} {
		raw, err := os.ReadFile("testdata/statement-v2/" + name + ".json")
		if err != nil {
			t.Fatal(err)
		}
		var v struct {
			Kind   string `json:"kind"`
			Inputs struct {
				AlibiID string            `json:"alibi_id"`
				Facts   map[string]string `json:"facts"`
				Parent  string            `json:"parent"`
				CardRef string            `json:"card_ref"`
			} `json:"inputs"`
			DigestHex    string `json:"digest_hex"`
			StatementHex string `json:"statement_hex"`
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatal(err)
		}
		l, err := ParseStatement(unhex(t, v.StatementHex))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if l.Kind != v.Kind || l.AlibiID != v.Inputs.AlibiID || l.Mode != Mode2of2 {
			t.Fatalf("%s: kind %s id %s mode %s", name, l.Kind, l.AlibiID, l.Mode)
		}
		if l.Parent == nil || "0x"+hex.EncodeToString(l.Parent[:]) != v.Inputs.Parent {
			t.Fatalf("%s: parent", name)
		}
		if hex.EncodeToString(l.CountersignDigest[:]) != v.DigestHex {
			t.Fatalf("%s: digest %x, want %s", name, l.CountersignDigest, v.DigestHex)
		}
		ref := v.Inputs.CardRef
		if v.Kind == KindCardSettlement {
			ref = v.Inputs.Facts["cardRef"]
			if l.Settlement == nil || strconv.FormatUint(l.Settlement.SettledMinor, 10) != v.Inputs.Facts["settledMinor"] ||
				"0x"+hex.EncodeToString(l.Settlement.TransactionHash[:]) != v.Inputs.Facts["transactionHash"] {
				t.Fatalf("%s: settlement", name)
			}
		} else if l.Authorization == nil || strconv.Itoa(int(l.Authorization.Decision)) != v.Inputs.Facts["decision"] {
			t.Fatalf("%s: authorization", name)
		}
		if l.CardRef == nil || "0x"+hex.EncodeToString(l.CardRef[:]) != ref {
			t.Fatalf("%s: card ref", name)
		}
	}
}
