// Package conformance builds the tree of the conformance log, a test-only log
// whose entries are deterministic, so any client can rebuild it at any size and
// sign honest or forked checkpoints to probe a witness.
package conformance

import (
	"fmt"

	"filippo.io/torchwood"
	"golang.org/x/mod/sumdb/note"
	"golang.org/x/mod/sumdb/tlog"
)

// Origin is the conformance log's origin.
const Origin = "log.keelson.finance/conformance/2026-1"

// Entry returns entry i of the log.
func Entry(i uint64) []byte { return fmt.Appendf(nil, "keelson conformance %d", i) }

// hashes is the tlog storage of the first n entries.
type hashes []tlog.Hash

func (h hashes) ReadHashes(indexes []int64) ([]tlog.Hash, error) {
	out := make([]tlog.Hash, len(indexes))
	for i, x := range indexes {
		out[i] = h[x]
	}
	return out, nil
}

func build(n uint64) hashes {
	var h hashes
	for i := range n {
		s, err := tlog.StoredHashes(int64(i), Entry(i), h)
		if err != nil {
			panic(err)
		}
		h = append(h, s...)
	}
	return h
}

// Tree returns the root of the log at size n.
func Tree(n uint64) [32]byte {
	root, err := tlog.TreeHash(int64(n), build(n))
	if err != nil {
		panic(err)
	}
	return root
}

// Consistency returns the RFC 6962 consistency proof from size m to size n.
func Consistency(m, n uint64) [][]byte {
	if m == 0 || m == n {
		return nil
	}
	p, err := tlog.ProveTree(int64(n), int64(m), build(n))
	if err != nil {
		panic(err)
	}
	out := make([][]byte, len(p))
	for i := range p {
		out[i] = p[i][:]
	}
	return out
}

// SignedCheckpoint returns the c2sp.org/tlog-checkpoint of size n and root,
// signed by signer. The root need not be the log's: forks are signed the same way.
func SignedCheckpoint(signer note.Signer, n uint64, root [32]byte) []byte {
	body := torchwood.Checkpoint{Origin: Origin, Tree: tlog.Tree{N: int64(n), Hash: root}}.String()
	signed, err := note.Sign(&note.Note{Text: body}, signer)
	if err != nil {
		panic(err)
	}
	return signed
}
