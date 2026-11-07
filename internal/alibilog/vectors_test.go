package alibilog

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

type vectorCase struct {
	Name              string            `json:"name"`
	Mode              string            `json:"mode"`
	Leaf              string            `json:"leaf"`
	LeafHash          string            `json:"leafHash"`
	Countersign       Countersign       `json:"countersign"`
	Digest            string            `json:"digest"`
	ChainID           uint64            `json:"chainId"`
	VerifyingContract string            `json:"verifyingContract"`
	Signers           map[string]string `json:"signers"`
}

type negativeCase struct {
	Name string `json:"name"`
	Leaf string `json:"leaf"`
	Code string `json:"code"`
}

func loadVectors(t testing.TB) (pos []vectorCase, neg []negativeCase) {
	t.Helper()
	raw, err := os.ReadFile("../../packages/log/test/vectors/leaf.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Positive []vectorCase   `json:"positive"`
		Negative []negativeCase `json:"negative"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v.Positive, v.Negative
}

func decode(t testing.TB, s string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
