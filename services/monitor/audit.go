package main

import (
	"context"
	"fmt"

	"github.com/DavidZapataOh/keelson-paypal/internal/alibilog"
	"github.com/transparency-dev/merkle/compact"
	"github.com/transparency-dev/tessera/api/layout"
	"github.com/transparency-dev/tessera/client"
)

type auditResult struct {
	degraded []uint64
	findings []Finding
}

// audit fetches the entries from rng.End() up to size, checks the format of
// each leaf, and appends each leaf hash to rng. A malformed leaf is a finding,
// not an error: it is in the tree all the same.
func audit(ctx context.Context, fetch client.EntryBundleFetcherFunc, rng *compact.Range, size uint64) (*auditResult, error) {
	res := &auditResult{}
	for rng.End() < size {
		first := rng.End()
		bundle, err := client.GetEntryBundle(ctx, fetch, first/layout.EntryBundleWidth, size)
		if err != nil {
			return nil, err
		}
		start := first % layout.EntryBundleWidth
		n := min(uint64(len(bundle.Entries)), start+(size-first))
		if n <= start {
			return nil, &findingError{Kind: "leaf.inclusion", Err: fmt.Errorf("the entry bundle of %d is short", first)}
		}
		for i, leaf := range bundle.Entries[start:n] {
			index := first + uint64(i)
			l, err := alibilog.Parse(leaf)
			switch {
			case err != nil:
				res.findings = append(res.findings, Finding{Kind: "leaf.format", Index: &index, Detail: err.Error()})
			case l.Mode == alibilog.ModeDegraded:
				res.degraded = append(res.degraded, index)
			}
			h := alibilog.LeafHash(leaf)
			if err := rng.Append(h[:], nil); err != nil {
				return nil, err
			}
		}
	}
	return res, nil
}
