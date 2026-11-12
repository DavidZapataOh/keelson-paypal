package main

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/DavidZapataOh/keelson-paypal/internal/alibilog"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/transparency-dev/tessera/api/layout"
	"github.com/transparency-dev/tessera/client"
)

// TEE kinds, as VerdictVerifier numbers them: a leaf's TeeSigs are [tdx] or
// [tdx, nitro].
var teeKinds = []uint8{1, 2}

// registration is one SignerRegistered event: the signer may sign in
// [From, Until) under Measurement.
type registration struct {
	From        uint64   `json:"from"`
	Until       uint64   `json:"until"`
	Measurement [32]byte `json:"measurement"`
}

// signerRecord is what VerdictVerifier's events say of one signer.
type signerRecord struct {
	Kind          uint8          `json:"kind"`
	Registrations []registration `json:"registrations"`
	// RevokedAt is 0 if the signer was never revoked.
	RevokedAt   uint64 `json:"revokedAt,omitempty"`
	Equivocated bool   `json:"equivocated,omitempty"`
	// Leaves are the latest maxListed leaf indices the signer signed, so an
	// equivocation found later voids them.
	Leaves []uint64 `json:"leaves,omitempty"`
}

// signerIndex is VerdictVerifier's signer registry as of Block, rebuilt from
// its events.
type signerIndex struct {
	Block   uint64                           `json:"block"`
	Signers map[common.Address]*signerRecord `json:"signers"`
}

func (x *signerIndex) clone() *signerIndex {
	if x == nil {
		return nil
	}
	c := &signerIndex{Block: x.Block, Signers: make(map[common.Address]*signerRecord, len(x.Signers))}
	for a, r := range x.Signers {
		rc := *r
		rc.Registrations = slices.Clone(r.Registrations)
		rc.Leaves = slices.Clone(r.Leaves)
		c.Signers[a] = &rc
	}
	return c
}

// SignerCheck is how far the leaves' TEE signatures were checked against the
// chain.
type SignerCheck struct {
	ChainID uint64 `json:"chainId"`
	Chain   string `json:"chain,omitempty"`
	// Next is the first leaf not checked yet; LeavesChecked counts the leaves
	// below it checked against the registry, and Predating those issued before
	// the registry existed, which it cannot speak for.
	Next          uint64 `json:"next"`
	LeavesChecked uint64 `json:"leavesChecked"`
	Predating     uint64 `json:"predating"`
	Block         uint64 `json:"block"`
	// Status is checked, not-deployed or error.
	Status    string    `json:"status"`
	Error     string    `json:"error,omitempty"`
	CheckedAt time.Time `json:"checkedAt"`
}

// syncSigners applies the registry's events after idx.Block to idx. It
// returns findings for leaves already checked whose signer has since been
// proven to equivocate.
func (c *chainReader) syncSigners(ctx context.Context, idx *signerIndex) ([]Finding, error) {
	from := max(idx.Block+1, c.t.FromBlock)
	logs, head, err := c.signerLogs(ctx, from)
	if err != nil {
		return nil, err
	}
	findings, err := idx.apply(logs)
	if err != nil {
		return nil, err
	}
	idx.Block = max(idx.Block, head)
	return findings, nil
}

func (idx *signerIndex) apply(logs []types.Log) ([]Finding, error) {
	if idx.Signers == nil {
		idx.Signers = map[common.Address]*signerRecord{}
	}
	var findings []Finding
	for _, l := range logs {
		if l.Removed || len(l.Topics) != 2 {
			continue
		}
		ev, err := verifierContract.EventByID(l.Topics[0])
		if err != nil {
			continue
		}
		v, err := ev.Inputs.NonIndexed().Unpack(l.Data)
		if err != nil {
			return nil, fmt.Errorf("%s at block %d: %w", ev.Name, l.BlockNumber, err)
		}
		signer := common.BytesToAddress(l.Topics[1].Bytes())
		r := idx.Signers[signer]
		if r == nil {
			r = &signerRecord{}
			idx.Signers[signer] = r
		}
		switch ev.Name {
		case "SignerRegistered":
			r.Kind = v[0].(uint8)
			r.Registrations = append(r.Registrations, registration{
				Measurement: v[1].([32]byte),
				From:        uint40(v[2]),
				Until:       uint40(v[3]),
			})
		case "SignerRevoked":
			if at := uint40(v[0]); r.RevokedAt == 0 || at < r.RevokedAt {
				r.RevokedAt = at
			}
		case "SignerEquivocated":
			if r.Equivocated {
				continue
			}
			r.Equivocated = true
			for _, i := range r.Leaves {
				findings = append(findings, Finding{Kind: "leaf.tee_equivocated", Index: &i,
					Detail: fmt.Sprintf("signer %s was proven to equivocate at block %d", signer, l.BlockNumber)})
			}
		}
	}
	return findings, nil
}

func uint40(v any) uint64 {
	b, ok := v.(interface{ Uint64() uint64 })
	if !ok {
		return 0
	}
	return b.Uint64()
}

// checkLeafSigners checks a leaf's TEE signatures: each recovers to a signer
// the registry holds for its leg, under the measurement the leaf names,
// registered while the countersign was valid (from its issuedAt for window; a
// leg first used by a countersign registers before signing it), not revoked
// before issuedAt, and never proven to equivocate. It records the leaf against
// its signers.
func checkLeafSigners(index uint64, l *alibilog.Leaf, idx *signerIndex, window time.Duration) *Finding {
	at := uint64(l.IssuedAt.Unix())
	end := at + uint64(window/time.Second)
	fail := func(kind, format string, args ...any) *Finding {
		return &Finding{Kind: kind, Index: &index, Detail: fmt.Sprintf(format, args...)}
	}
	var signers []*signerRecord
	for i, sig := range l.TeeSigs {
		addr, err := alibilog.Recover(l.CountersignDigest, sig)
		if err != nil {
			return fail("leaf.tee_signature", "signature %d: %v", i, err)
		}
		signer := common.Address(addr)
		r := idx.Signers[signer]
		if r == nil || r.Kind != teeKinds[i] {
			return fail("leaf.tee_signer", "signer %s is not registered as TEE kind %d", signer, teeKinds[i])
		}
		reg := slices.IndexFunc(r.Registrations, func(g registration) bool { return g.From < end && at < g.Until })
		if reg < 0 || (r.RevokedAt != 0 && r.RevokedAt <= at) {
			return fail("leaf.tee_signer", "signer %s was not active at %s", signer, l.IssuedAt.Format(time.RFC3339))
		}
		if r.Registrations[reg].Measurement != l.Measurements[i] {
			return fail("leaf.tee_measurement", "signer %s is registered under another measurement", signer)
		}
		if r.Equivocated {
			return fail("leaf.tee_equivocated", "signer %s was proven to equivocate", signer)
		}
		signers = append(signers, r)
	}
	for _, r := range signers {
		r.Leaves = append(r.Leaves, index)
		if n := len(r.Leaves); n > maxListed {
			r.Leaves = slices.Delete(r.Leaves, 0, n-maxListed)
		}
	}
	return nil
}

// checkSigners syncs the signer index and checks the TEE signatures of the
// leaves [cur.Signers.Next, cur.Size). A registry or log that cannot be read
// leaves the cursor where it was and is no finding.
func (f *follower) checkSigners(ctx context.Context, cur OriginState) (SignerCheck, *signerIndex, []Finding) {
	sc := SignerCheck{ChainID: f.o.Chain.ChainID, Chain: f.o.Chain.Name}
	if cur.Signers != nil {
		sc = *cur.Signers
		sc.Error = ""
	}
	sc.CheckedAt = time.Now()
	idx := cur.SignerIndex.clone()
	if idx == nil {
		idx = &signerIndex{}
	}
	findings, err := f.chain.syncSigners(ctx, idx)
	if err != nil {
		sc.Status, sc.Error = "error", err.Error()
		return sc, cur.SignerIndex, nil
	}
	sc.Block = idx.Block
	for sc.Next < cur.Size {
		first := sc.Next
		bundle, err := client.GetEntryBundle(ctx, f.fetcher.ReadEntryBundle, first/layout.EntryBundleWidth, cur.Size)
		if err != nil {
			sc.Status, sc.Error = "error", err.Error()
			return sc, idx, findings
		}
		start := first % layout.EntryBundleWidth
		n := min(uint64(len(bundle.Entries)), start+(cur.Size-first))
		if n <= start {
			sc.Status, sc.Error = "error", fmt.Sprintf("the entry bundle of %d is short", first)
			return sc, idx, findings
		}
		for i, leaf := range bundle.Entries[start:n] {
			index := first + uint64(i)
			sc.Next = index + 1
			if alibilog.IsStop(leaf) {
				continue
			}
			l, err := alibilog.Parse(leaf)
			if err != nil {
				// Already a leaf.format finding.
				continue
			}
			if l.IssuedAt.Before(f.o.Chain.FromTime) {
				sc.Predating++
				continue
			}
			if fd := checkLeafSigners(index, l, idx, f.o.Chain.CountersignWindow); fd != nil && len(findings) < maxFindings {
				findings = append(findings, *fd)
			}
			sc.LeavesChecked++
		}
	}
	sc.Status = "checked"
	return sc, idx, findings
}
