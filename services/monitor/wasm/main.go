//go:build js && wasm

// Command wasm is the monitor page's verifier. It checks, in the viewer's
// browser and from data fetched directly from the log, a checkpoint against
// the pinned policy, consistency with a checkpoint seen earlier, and the
// inclusion and format of any leaf, with the same Go packages the monitor runs.
package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"syscall/js"

	"filippo.io/torchwood"
	"github.com/DavidZapataOh/keelson-paypal/internal/alibilog"
	"golang.org/x/mod/sumdb/tlog"
)

func main() {
	js.Global().Set("keelsonVerifier", js.ValueOf(map[string]any{
		"verifyCheckpoint":  js.FuncOf(async(verifyCheckpoint)),
		"verifyConsistency": js.FuncOf(async(verifyConsistency)),
		"verifyInclusion":   js.FuncOf(async(verifyInclusion)),
		"parseLeaf":         js.FuncOf(async(parseLeaf)),
		"prove":             js.FuncOf(async(prove)),
	}))
	select {}
}

// async runs fn on a goroutine, where it may block on the network, and
// returns a Promise of its result. An error rejects the Promise.
func async(fn func(args []js.Value) (any, error)) func(js.Value, []js.Value) any {
	return func(_ js.Value, args []js.Value) any {
		var executor js.Func
		executor = js.FuncOf(func(_ js.Value, p []js.Value) any {
			resolve, reject := p[0], p[1]
			go func() {
				defer executor.Release()
				v, err := fn(args)
				if err != nil {
					reject.Invoke(js.Global().Get("Error").New(err.Error()))
					return
				}
				resolve.Invoke(v)
			}()
			return nil
		})
		return js.Global().Get("Promise").New(executor)
	}
}

func b64(h []byte) string { return base64.StdEncoding.EncodeToString(h) }

func hashes(v js.Value) ([]tlog.Hash, error) {
	out := make([]tlog.Hash, v.Length())
	for i := range out {
		b, err := base64.StdEncoding.DecodeString(v.Index(i).String())
		if err != nil || len(b) != tlog.HashSize {
			return nil, errors.New("malformed proof hash")
		}
		out[i] = tlog.Hash(b)
	}
	return out, nil
}

func strs(h []tlog.Hash) []any {
	out := make([]any, len(h))
	for i := range h {
		out[i] = b64(h[i][:])
	}
	return out
}

// verifyCheckpoint(note, policy) checks the log's signatures and the witness
// quorum, and returns the tree and the witnesses that cosigned.
func verifyCheckpoint(args []js.Value) (any, error) {
	signed, policyText := []byte(args[0].String()), []byte(args[1].String())
	p, err := torchwood.ParsePolicy(policyText)
	if err != nil {
		return nil, fmt.Errorf("policy: %w", err)
	}
	c, n, err := torchwood.VerifyCheckpoint(signed, p)
	if err != nil {
		return nil, err
	}
	var cosigners []any
	for _, s := range n.Sigs {
		if s.Name != c.Origin && !slices.Contains(cosigners, any(s.Name)) {
			cosigners = append(cosigners, s.Name)
		}
	}
	return map[string]any{"origin": c.Origin, "size": c.N, "root": b64(c.Hash[:]), "cosigners": cosigners}, nil
}

// checkpoint parses the body of a signed checkpoint the caller verified.
func checkpoint(signed string) (torchwood.Checkpoint, error) {
	body, _, _ := strings.Cut(signed, "\n\n")
	return torchwood.ParseCheckpoint(body + "\n")
}

// verifyConsistency(oldNote, newNote, proof) checks that the newer tree
// extends the older one.
func verifyConsistency(args []js.Value) (any, error) {
	a, err := checkpoint(args[0].String())
	if err != nil {
		return nil, err
	}
	b, err := checkpoint(args[1].String())
	if err != nil {
		return nil, err
	}
	p, err := hashes(args[2])
	if err != nil {
		return nil, err
	}
	if a.Origin != b.Origin {
		return nil, errors.New("the checkpoints are of different origins")
	}
	if err := tlog.CheckTree(p, b.N, b.Hash, a.N, a.Hash); err != nil {
		return nil, fmt.Errorf("size %d does not extend size %d: %w", b.N, a.N, err)
	}
	return true, nil
}

// verifyInclusion(index, leafHash, proof, note) checks that the leaf is at
// index in the checkpoint's tree.
func verifyInclusion(args []js.Value) (any, error) {
	index := int64(args[0].Int())
	h, err := hashes(js.ValueOf([]any{args[1].String()}))
	if err != nil {
		return nil, err
	}
	p, err := hashes(args[2])
	if err != nil {
		return nil, err
	}
	c, err := checkpoint(args[3].String())
	if err != nil {
		return nil, err
	}
	if err := tlog.CheckRecord(p, c.N, c.Hash, index, h[0]); err != nil {
		return nil, fmt.Errorf("leaf %d is not in the tree of size %d: %w", index, c.N, err)
	}
	return true, nil
}

// parseLeaf(bytes) checks the leaf's format and returns its mode and hash.
func parseLeaf(args []js.Value) (any, error) {
	leaf, err := base64.StdEncoding.DecodeString(args[0].String())
	if err != nil {
		return nil, err
	}
	l, err := alibilog.Parse(leaf)
	if err != nil {
		return nil, err
	}
	h := alibilog.LeafHash(leaf)
	return map[string]any{
		"alibiId":  l.AlibiID,
		"mode":     l.Mode,
		"issuedAt": l.IssuedAt.UTC().Format("2006-01-02T15:04:05Z"),
		"leafHash": b64(h[:]),
	}, nil
}

// prove(logURL, size, root, oldSize, index) fetches from the log the tiles of
// the tree of that size and root, checking each against the root, and returns
// the consistency proof from oldSize and the inclusion proof and entry at
// index. oldSize or index may be -1 to skip them.
func prove(args []js.Value) (any, error) {
	base := strings.TrimSuffix(args[0].String(), "/") + "/"
	size := int64(args[1].Int())
	root, err := hashes(js.ValueOf([]any{args[2].String()}))
	if err != nil {
		return nil, err
	}
	oldSize, index := int64(args[3].Int()), int64(args[4].Int())
	tree := tlog.Tree{N: size, Hash: root[0]}
	tr := tileReader{base: base}
	hr := torchwood.TileHashReaderWithContext(context.Background(), tree, tr)
	out := map[string]any{}
	if oldSize > 0 && oldSize < size {
		p, err := tlog.ProveTree(size, oldSize, hr)
		if err != nil {
			return nil, fmt.Errorf("tiles: %w", err)
		}
		out["consistency"] = strs(p)
	}
	if index >= 0 {
		if index >= size {
			return nil, fmt.Errorf("index %d is not below the tree size %d", index, size)
		}
		p, err := tlog.ProveRecord(size, index, hr)
		if err != nil {
			return nil, fmt.Errorf("tiles: %w", err)
		}
		out["inclusion"] = strs(p)
		entry, err := tr.entry(size, index)
		if err != nil {
			return nil, fmt.Errorf("entry: %w", err)
		}
		out["entry"] = b64(entry)
	}
	return out, nil
}

// tileReader fetches c2sp.org/tlog-tiles resources with the browser's fetch.
type tileReader struct{ base string }

func (r tileReader) ReadTiles(ctx context.Context, tiles []tlog.Tile) ([][]byte, error) {
	out := make([][]byte, len(tiles))
	for i, t := range tiles {
		b, err := r.get(ctx, t)
		if err != nil {
			return nil, err
		}
		out[i] = b
	}
	return out, nil
}

func (tileReader) SaveTiles([]tlog.Tile, [][]byte) {}

// get fetches a tile, falling back to the full tile if the partial one is gone.
func (r tileReader) get(ctx context.Context, t tlog.Tile) ([]byte, error) {
	b, err := r.ReadEndpoint(ctx, torchwood.TilePath(t))
	if errors.Is(err, errNotFound) && t.W < torchwood.TileWidth {
		full := t
		full.W = torchwood.TileWidth
		if b, err = r.ReadEndpoint(ctx, torchwood.TilePath(full)); err == nil && t.L >= 0 && len(b) >= t.W*tlog.HashSize {
			b = b[:t.W*tlog.HashSize]
		}
	}
	return b, err
}

var errNotFound = errors.New("not found")

// ReadEndpoint fetches a resource under the log's prefix.
func (r tileReader) ReadEndpoint(ctx context.Context, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.base+path, nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case http.StatusOK:
		return io.ReadAll(res.Body)
	case http.StatusNotFound:
		return nil, fmt.Errorf("%s: %w", path, errNotFound)
	default:
		return nil, fmt.Errorf("%s: %s", path, res.Status)
	}
}

// entry returns entry index of the tree of size.
func (r tileReader) entry(size, index int64) ([]byte, error) {
	n := index / torchwood.TileWidth
	t := tlog.Tile{H: torchwood.TileHeight, L: -1, N: n, W: int(min(torchwood.TileWidth, size-n*torchwood.TileWidth))}
	b, err := r.get(context.Background(), t)
	if err != nil {
		return nil, err
	}
	for range index % torchwood.TileWidth {
		if _, b, err = torchwood.ReadTileEntry(b); err != nil {
			return nil, err
		}
	}
	e, _, err := torchwood.ReadTileEntry(b)
	return e, err
}
