package main

import (
	"bytes"
	"context"
	"fmt"
	"time"

	"github.com/transparency-dev/merkle/proof"
	"github.com/transparency-dev/merkle/rfc6962"
	"github.com/transparency-dev/tessera/client"
)

// AnchorCheck is the origin's latest on-chain anchor as the monitor last
// compared it with its verified view.
type AnchorCheck struct {
	ChainID uint64 `json:"chainId"`
	Chain   string `json:"chain,omitempty"`
	Size    uint64 `json:"size"`
	Root    []byte `json:"root,omitempty"`
	// Status is consistent, inconsistent, ahead (anchored beyond the verified
	// view, checked again later), none (nothing anchored yet), not-deployed or
	// error.
	Status    string    `json:"status"`
	Error     string    `json:"error,omitempty"`
	CheckedAt time.Time `json:"checkedAt"`
}

// checkAnchor reads the origin's latest anchor and proves its root consistent
// with the verified view. An anchor the view does not extend is a finding; a
// chain or log that cannot be read is not.
func (f *follower) checkAnchor(ctx context.Context, cur OriginState) (AnchorCheck, *Finding) {
	c := AnchorCheck{ChainID: f.o.Chain.ChainID, Chain: f.o.Chain.Name, CheckedAt: time.Now()}
	size, root, _, err := f.chain.latestAnchor(ctx, f.o.Name)
	if err != nil {
		c.Status, c.Error = "error", err.Error()
		return c, nil
	}
	c.Size, c.Root = size, root[:]
	switch {
	case size == 0:
		c.Status = "none"
		return c, nil
	case size > cur.Size:
		c.Status = "ahead"
		return c, nil
	case size == cur.Size:
		if bytes.Equal(root[:], cur.Root) {
			c.Status = "consistent"
			return c, nil
		}
	default:
		pb, err := client.NewProofBuilder(ctx, cur.Size, f.fetcher.ReadTile)
		if err == nil {
			var p [][]byte
			if p, err = pb.ConsistencyProof(ctx, size, cur.Size); err == nil {
				if proof.VerifyConsistency(rfc6962.DefaultHasher, size, cur.Size, p, root[:], cur.Root) == nil {
					c.Status = "consistent"
					return c, nil
				}
			}
		}
		if err != nil {
			c.Status, c.Error = "error", err.Error()
			return c, nil
		}
	}
	c.Status = "inconsistent"
	return c, &Finding{Kind: "anchor.root", At: time.Now(),
		Detail: fmt.Sprintf("the root anchored on %s at size %d is not in the verified tree of size %d", f.o.Chain.Name, size, cur.Size)}
}
