package main

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

func readRegistry(t *testing.T, chainID string) (contracts map[string]string, disputeWindow int64) {
	t.Helper()
	raw, err := os.ReadFile("../../contracts/deployments/" + chainID + ".json")
	if err != nil {
		t.Fatal(err)
	}
	var r struct {
		Contracts map[string]string `json:"contracts"`
		Params    struct {
			DisputeWindow int64 `json:"disputeWindow"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	return r.Contracts, r.Params.DisputeWindow
}

func TestPinnedAddressesMatchRegistry(t *testing.T) {
	ct := arbitrumSepolia(func(string) string { return "" })
	c, window := readRegistry(t, "421614")
	if common.HexToAddress(c["CheckpointAnchor"]) != ct.CheckpointAnchor || common.HexToAddress(c["VerdictVerifier"]) != ct.VerdictVerifier {
		t.Fatalf("pinned %s, %s; registry %s, %s", ct.CheckpointAnchor, ct.VerdictVerifier, c["CheckpointAnchor"], c["VerdictVerifier"])
	}
	if ct.CountersignWindow != time.Duration(window)*time.Second {
		t.Fatalf("countersign window %v, dispute window %ds", ct.CountersignWindow, window)
	}
	if c, _ := readRegistry(t, "42161"); c["CheckpointAnchor"] != "" || arbitrumOne.CheckpointAnchor != (common.Address{}) {
		t.Fatalf("Arbitrum One has a CheckpointAnchor now (%s): pin it", c["CheckpointAnchor"])
	}
}

func TestAnchorABIMatchesLog(t *testing.T) {
	f, err := os.Open("../log/abi/CheckpointAnchor.json")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	full, err := abi.JSON(f)
	if err != nil {
		t.Fatal(err)
	}
	for name, m := range anchorContract.Methods {
		if full.Methods[name].ID == nil || string(full.Methods[name].ID) != string(m.ID) {
			t.Errorf("%s: selector %x, contract %x", name, m.ID, full.Methods[name].ID)
		}
	}
}
