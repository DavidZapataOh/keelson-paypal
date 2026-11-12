package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"slices"
	"testing"
	"time"
)

func statementLeaf(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile("../../internal/alibilog/testdata/statement-v2/" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		StatementHex string `json:"statement_hex"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	leaf, err := hex.DecodeString(v.StatementHex)
	if err != nil {
		t.Fatal(err)
	}
	return leaf
}

func TestFollowerAuditsStatementLeaves(t *testing.T) {
	vectors := loadVectors(t)
	keys := newLogKeys(t, testOrigin)
	ws := keys.startWitnesses(t, testOrigin, nil)
	p := witnessPolicy(keys.vkey, ws)
	dir := t.TempDir()
	l := openTestLog(t, dir, keys.signer, p)
	srv := serveLog(t, dir)
	o := testOriginAt(t, srv.URL, p)

	leaves := freshLeaves(t, vectors["allow"], 3)
	for _, name := range []string{"allow-2of2", "allow-degraded", "card-2of2", "card-auth-approve", "card-settlement", "bridge-degraded"} {
		leaves = append(leaves, statementLeaf(t, name))
	}
	bad := bytes.Clone(statementLeaf(t, "deny-2of2"))
	bad[len(bad)-1] ^= 1
	leaves = append(leaves, bad)
	l.append(t, leaves...)

	m := startMonitor(t, t.TempDir(), o)
	r := m.waitFor(t, 30*time.Second, func(r Report) bool { return r.Size == 10 })
	if r.LeavesAudited != 10 {
		t.Fatalf("report: %+v", r)
	}
	// Only purchases count as degraded: the bridge of a degraded v1 purchase is not a second one.
	if !slices.Equal(r.DegradedLeaves, []uint64{4}) {
		t.Fatalf("degraded leaves: %v, want [4]", r.DegradedLeaves)
	}
	if len(r.Findings) != 1 || r.Findings[0].Kind != "leaf.format" || *r.Findings[0].Index != 9 {
		t.Fatalf("findings: %+v", r.Findings)
	}
}
