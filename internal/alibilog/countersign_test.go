package alibilog

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
)

func hexBytes(t testing.TB, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func contract(t testing.TB, s string) (a [20]byte) {
	copy(a[:], hexBytes(t, s))
	return a
}

func TestDigestEqualsTheVectors(t *testing.T) {
	pos, _ := loadVectors(t)
	for _, v := range pos {
		d := Digest(v.Countersign, v.ChainID, contract(t, v.VerifyingContract))
		if "0x"+hex.EncodeToString(d[:]) != v.Digest {
			t.Fatalf("%s: digest %x, want %s", v.Name, d, v.Digest)
		}
	}
}

func TestRecoverReturnsTheRealSigners(t *testing.T) {
	pos, _ := loadVectors(t)
	for _, v := range pos {
		l, err := Parse(decode(t, v.Leaf))
		if err != nil {
			t.Fatal(err)
		}
		digest := Digest(v.Countersign, v.ChainID, contract(t, v.VerifyingContract))
		legs := []string{"tdx", "nitro"}
		for i, sig := range l.TeeSigs {
			addr, err := Recover(digest, sig)
			if err != nil {
				t.Fatalf("%s %s: %v", v.Name, legs[i], err)
			}
			if !strings.EqualFold("0x"+hex.EncodeToString(addr[:]), v.Signers[legs[i]]) {
				t.Fatalf("%s %s: recovered %x, want %s", v.Name, legs[i], addr, v.Signers[legs[i]])
			}
		}
	}
}

func TestRecoverRejectsMalleableSignatures(t *testing.T) {
	pos, _ := loadVectors(t)
	l, err := Parse(decode(t, pos[0].Leaf))
	if err != nil {
		t.Fatal(err)
	}
	digest := Digest(pos[0].Countersign, pos[0].ChainID, contract(t, pos[0].VerifyingContract))
	sig := l.TeeSigs[0]

	n := secp256k1.Params().N
	s := new(big.Int).SetBytes(sig[32:64])
	high := sig
	new(big.Int).Sub(n, s).FillBytes(high[32:64])
	high[64] = 55 - high[64] // 27 <-> 28: (r, n-s) is the same signature with the other parity.
	if _, err := Recover(digest, high); !errors.Is(err, ErrHighS) {
		t.Fatalf("high-S: %v", err)
	}
	for _, v := range []byte{0, 1, 29, 35} {
		bad := sig
		bad[64] = v
		if _, err := Recover(digest, bad); err == nil {
			t.Fatalf("v = %d accepted", v)
		}
	}
}

func TestMatchesFailsOnEachBoundField(t *testing.T) {
	pos, _ := loadVectors(t)
	l, err := Parse(decode(t, pos[0].Leaf))
	if err != nil {
		t.Fatal(err)
	}
	c := pos[0].Countersign
	if err := l.Matches(c); err != nil {
		t.Fatal(err)
	}
	flip := func(b [32]byte) [32]byte { b[31] ^= 1; return b }
	changed := map[string]func(c *Countersign){
		"requestId":         func(c *Countersign) { c.RequestID = flip(c.RequestID) },
		"mandateHash":       func(c *Countersign) { c.MandateHash = flip(c.MandateHash) },
		"mandateCommitment": func(c *Countersign) { c.MandateCommitment = flip(c.MandateCommitment) },
		"cartHash":          func(c *Countersign) { c.CartHash = flip(c.CartHash) },
		"evidenceRoot":      func(c *Countersign) { c.EvidenceRoot = flip(c.EvidenceRoot) },
		"evalHash":          func(c *Countersign) { c.EvalHash = flip(c.EvalHash) },
		"policySetHash":     func(c *Countersign) { c.PolicySetHash = flip(c.PolicySetHash) },
		"agentId":           func(c *Countersign) { c.AgentID = new(big.Int).Add(c.AgentID, big.NewInt(1)) },
		"issuedAt":          func(c *Countersign) { c.IssuedAt++ },
	}
	for name, change := range changed {
		other := c
		other.AgentID = new(big.Int).Set(c.AgentID)
		change(&other)
		if err := l.Matches(other); err == nil {
			t.Errorf("%s changed and still matches", name)
		}
	}
}

func TestCountersignJSONIsStrict(t *testing.T) {
	pos, _ := loadVectors(t)
	var c Countersign
	for _, bad := range []string{
		`{}`,
		strings.Replace(mustJSON(t, pos[0].Countersign), `"currency":"840"`, `"currency":"65536"`, 1),
		strings.Replace(mustJSON(t, pos[0].Countersign), `"agentId":"42"`, `"agentId":"-1"`, 1),
		strings.Replace(mustJSON(t, pos[0].Countersign), `"decision":"1"`, `"decision":"1","extra":"1"`, 1),
	} {
		if err := c.UnmarshalJSON([]byte(bad)); err == nil {
			t.Errorf("accepted %.60s", bad)
		}
	}
}

func mustJSON(t testing.TB, c Countersign) string {
	b, err := c.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func BenchmarkAdmissionCrypto(b *testing.B) {
	pos, _ := loadVectors(b)
	v := pos[0]
	leaf := decode(b, v.Leaf)
	vc := contract(b, v.VerifyingContract)
	for b.Loop() {
		l, err := Parse(leaf)
		if err != nil {
			b.Fatal(err)
		}
		d := Digest(v.Countersign, v.ChainID, vc)
		for _, s := range l.TeeSigs {
			if _, err := Recover(d, s); err != nil {
				b.Fatal(err)
			}
		}
	}
}

func TestCheckpointDigestEqualsTheVectors(t *testing.T) {
	raw, err := os.ReadFile("../../packages/core/test/vectors/eip712.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name  string `json:"name"`
		Input struct {
			ChainID           uint64            `json:"chainId"`
			VerifyingContract string            `json:"verifyingContract"`
			PrimaryType       string            `json:"primaryType"`
			Message           map[string]string `json:"message"`
		} `json:"input"`
		Expected string `json:"expected"`
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, v := range vectors {
		if v.Input.PrimaryType != "Checkpoint" {
			continue
		}
		size, err := strconv.ParseUint(v.Input.Message["treeSize"], 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		d := CheckpointDigest([32]byte(hexBytes(t, v.Input.Message["origin"])), size,
			[32]byte(hexBytes(t, v.Input.Message["rootHash"])), v.Input.ChainID, contract(t, v.Input.VerifyingContract))
		if "0x"+hex.EncodeToString(d[:]) != v.Expected {
			t.Fatalf("%s: digest %x, want %s", v.Name, d, v.Expected)
		}
		n++
	}
	if n != 2 {
		t.Fatalf("%d Checkpoint vectors, want 2", n)
	}
}
