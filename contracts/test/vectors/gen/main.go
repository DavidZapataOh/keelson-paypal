// Command gen writes the RFC 6962 and checkpoint vectors of the contract tests.
//
//	gen rfc6962 <sandbox note>                  > rfc6962.json
//	gen checkpoints <sandbox note>              > checkpoints.json
//	gen note <size>
//
// rfc6962 emits every consistency pair and inclusion proof of the conformance
// tree up to size 64, a negative twin of each, the proofs of a 2^20 - 1 tree
// for the gas cases, and real proofs of the sandbox log at the note's size read
// from its public tiles. Every vector is checked with transparency-dev/merkle
// before it is written.
//
// checkpoints asks both live legs to sign the sandbox note and the
// conformance checkpoints, honest and forked, signed with
// LOG_SIGNER_KEY_CONFORMANCE. It reads TEE_A_URL, TEE_B_URL, KEELSON_TEE_TOKEN
// and KEELSON_VERIFYING_CONTRACT.
//
// note prints the conformance checkpoint of the given size.
package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"filippo.io/torchwood"
	"github.com/DavidZapataOh/keelson-paypal/internal/conformance"
	"github.com/transparency-dev/merkle/proof"
	"github.com/transparency-dev/merkle/rfc6962"
	"github.com/transparency-dev/tessera/client"
	"golang.org/x/mod/sumdb/note"
	"golang.org/x/mod/sumdb/tlog"
)

const sandboxURL = "https://log.keelson.finance/alibi/2026-1/"

// Sizes of the conformance trees of the checkpoint vectors: the gas case
// anchors gasFrom, then gasTo with a 20-node consistency proof.
const (
	gasFrom = 1
	gasTo   = 1<<20 - 1
	// forkAt is the first entry where the forked conformance tree differs.
	forkAt = 4
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "gen:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	ctx := context.Background()
	switch {
	case len(args) == 2 && args[0] == "rfc6962":
		return writeJSON(rfc6962Vectors(ctx, args[1]))
	case len(args) == 2 && args[0] == "statements":
		return writeJSON(statementVectors(args[1]))
	case len(args) == 2 && args[0] == "checkpoints":
		return writeJSON(checkpointVectors(ctx, args[1]))
	case len(args) == 2 && args[0] == "note":
		n, err := strconv.ParseUint(args[1], 10, 64)
		if err != nil {
			return err
		}
		s, err := conformanceSigner()
		if err != nil {
			return err
		}
		_, err = os.Stdout.Write(conformance.SignedCheckpoint(s, n, conformance.Tree(n)))
		return err
	}
	return errors.New("usage: gen rfc6962 <note> | gen checkpoints <note> | gen note <size> | gen statements <repo root>")
}

func writeJSON[T any](v T, err error) error {
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	return enc.Encode(v)
}

// tree is the tlog storage of a log's first entries.
type tree []tlog.Hash

func (t tree) ReadHashes(indexes []int64) ([]tlog.Hash, error) {
	out := make([]tlog.Hash, len(indexes))
	for i, x := range indexes {
		out[i] = t[x]
	}
	return out, nil
}

func build(n uint64, entry func(uint64) []byte) tree {
	var t tree
	for i := range n {
		s, err := tlog.StoredHashes(int64(i), entry(i), t)
		if err != nil {
			panic(err)
		}
		t = append(t, s...)
	}
	return t
}

func (t tree) root(n uint64) tlog.Hash {
	h, err := tlog.TreeHash(int64(n), t)
	if err != nil {
		panic(err)
	}
	return h
}

func (t tree) consistency(m, n uint64) []tlog.Hash {
	if m == n {
		return nil
	}
	p, err := tlog.ProveTree(int64(n), int64(m), t)
	if err != nil {
		panic(err)
	}
	return p
}

func (t tree) inclusion(i, n uint64) []tlog.Hash {
	p, err := tlog.ProveRecord(int64(n), int64(i), t)
	if err != nil {
		panic(err)
	}
	return p
}

// forked is the conformance tree with entries from forkAt replaced.
func forked(i uint64) []byte {
	if i < forkAt {
		return conformance.Entry(i)
	}
	return fmt.Appendf(nil, "keelson conformance fork %d", i)
}

type hash32 [32]byte

func (h hash32) MarshalJSON() ([]byte, error) {
	return json.Marshal("0x" + hex.EncodeToString(h[:]))
}

type consistencyVector struct {
	OK    bool     `json:"ok"`
	Proof []hash32 `json:"proof"`
	Root1 hash32   `json:"root1"`
	Root2 hash32   `json:"root2"`
	Size1 uint64   `json:"size1"`
	Size2 uint64   `json:"size2"`
}

type inclusionVector struct {
	Index    uint64   `json:"index"`
	LeafHash hash32   `json:"leafHash"`
	OK       bool     `json:"ok"`
	Proof    []hash32 `json:"proof"`
	Root     hash32   `json:"root"`
	Size     uint64   `json:"size"`
}

type rfc6962File struct {
	Consistency []consistencyVector `json:"consistency"`
	Inclusion   []inclusionVector   `json:"inclusion"`
	// Gas and Sandbox hold the vectors of the gas cases and of the sandbox log.
	GasConsistency   consistencyVector   `json:"gasConsistency"`
	GasInclusion     inclusionVector     `json:"gasInclusion"`
	SandboxSize      uint64              `json:"sandboxSize"`
	SandboxInclusion []inclusionVector   `json:"sandboxInclusion"`
	SandboxConsist   []consistencyVector `json:"sandboxConsistency"`
}

func hashes(p []tlog.Hash) []hash32 {
	out := make([]hash32, len(p))
	for i := range p {
		out[i] = hash32(p[i])
	}
	return out
}

func raw(p []hash32) [][]byte {
	out := make([][]byte, len(p))
	for i := range p {
		out[i] = p[i][:]
	}
	return out
}

func checkConsistency(v consistencyVector) error {
	err := proof.VerifyConsistency(rfc6962.DefaultHasher, v.Size1, v.Size2, raw(v.Proof), v.Root1[:], v.Root2[:])
	if (err == nil) != v.OK {
		return fmt.Errorf("consistency %d → %d: ok = %v but merkle says %v", v.Size1, v.Size2, v.OK, err)
	}
	return nil
}

func checkInclusion(v inclusionVector) error {
	err := proof.VerifyInclusion(rfc6962.DefaultHasher, v.Index, v.Size, v.LeafHash[:], raw(v.Proof), v.Root[:])
	if (err == nil) != v.OK {
		return fmt.Errorf("inclusion %d in %d: ok = %v but merkle says %v", v.Index, v.Size, v.OK, err)
	}
	return nil
}

// negativeConsistency breaks a positive vector in one of three ways, chosen by k.
func negativeConsistency(v consistencyVector, other hash32, k int) consistencyVector {
	v.OK = false
	v.Proof = slices.Clone(v.Proof)
	switch {
	case k%3 == 0 && len(v.Proof) > 0:
		v.Proof[k%len(v.Proof)][k%32] ^= 1 << (k % 8)
	case k%3 == 1 && len(v.Proof) > 0:
		v.Proof = v.Proof[:len(v.Proof)-1]
	default:
		v.Root2 = other
	}
	return v
}

func negativeInclusion(v inclusionVector, k int) inclusionVector {
	v.OK = false
	v.Proof = slices.Clone(v.Proof)
	switch {
	case k%3 == 0 && len(v.Proof) > 0:
		v.Proof[k%len(v.Proof)][k%32] ^= 1 << (k % 8)
	case k%3 == 1 && len(v.Proof) > 0:
		v.Proof = v.Proof[:len(v.Proof)-1]
	default:
		v.LeafHash[k%32] ^= 1
	}
	return v
}

func rfc6962Vectors(ctx context.Context, sandboxNote string) (*rfc6962File, error) {
	const max = 64
	t := build(max, conformance.Entry)
	var f rfc6962File
	k := 0
	for n := uint64(1); n <= max; n++ {
		for m := uint64(1); m <= n; m++ {
			v := consistencyVector{OK: true, Proof: hashes(t.consistency(m, n)), Root1: hash32(t.root(m)), Root2: hash32(t.root(n)), Size1: m, Size2: n}
			other := hash32(t.root(n%max + 1))
			if n == max {
				other = hash32(t.root(1))
			}
			f.Consistency = append(f.Consistency, v, negativeConsistency(v, other, k))
			k++
		}
		for i := range n {
			v := inclusionVector{Index: i, LeafHash: hash32(tlog.RecordHash(conformance.Entry(i))), OK: true, Proof: hashes(t.inclusion(i, n)), Root: hash32(t.root(n)), Size: n}
			f.Inclusion = append(f.Inclusion, v, negativeInclusion(v, k))
			k++
		}
	}

	big := build(gasTo, conformance.Entry)
	f.GasConsistency = consistencyVector{OK: true, Proof: hashes(big.consistency(gasFrom, gasTo)), Root1: hash32(big.root(gasFrom)), Root2: hash32(big.root(gasTo)), Size1: gasFrom, Size2: gasTo}
	const gasIndex = gasTo / 3
	f.GasInclusion = inclusionVector{Index: gasIndex, LeafHash: hash32(tlog.RecordHash(conformance.Entry(gasIndex))), OK: true, Proof: hashes(big.inclusion(gasIndex, gasTo)), Root: hash32(big.root(gasTo)), Size: gasTo}
	if len(f.GasConsistency.Proof) != 20 || len(f.GasInclusion.Proof) != 20 {
		return nil, fmt.Errorf("gas proofs have %d and %d nodes, want 20", len(f.GasConsistency.Proof), len(f.GasInclusion.Proof))
	}

	c, err := readNote(sandboxNote)
	if err != nil {
		return nil, err
	}
	size := uint64(c.N)
	fetcher, pb, err := sandboxProofs(ctx, size)
	if err != nil {
		return nil, err
	}
	f.SandboxSize = size
	for _, i := range []uint64{0, size / 2, size - 1} {
		p, err := pb.InclusionProof(ctx, i)
		if err != nil {
			return nil, err
		}
		leaves, err := client.FetchLeafHashes(ctx, fetcher.ReadTile, i, 1, size)
		if err != nil {
			return nil, err
		}
		f.SandboxInclusion = append(f.SandboxInclusion, inclusionVector{Index: i, LeafHash: hash32(leaves[0]), OK: true, Proof: toHashes(p), Root: hash32(c.Hash), Size: size})
	}
	for _, m := range []uint64{1, size / 2} {
		p, err := pb.ConsistencyProof(ctx, m, size)
		if err != nil {
			return nil, err
		}
		old, err := sandboxRoot(ctx, fetcher, m, size)
		if err != nil {
			return nil, err
		}
		f.SandboxConsist = append(f.SandboxConsist, consistencyVector{OK: true, Proof: toHashes(p), Root1: old, Root2: hash32(c.Hash), Size1: m, Size2: size})
	}

	for _, v := range append(append(f.Consistency, f.GasConsistency), f.SandboxConsist...) {
		if err := checkConsistency(v); err != nil {
			return nil, err
		}
	}
	for _, v := range append(append(f.Inclusion, f.GasInclusion), f.SandboxInclusion...) {
		if err := checkInclusion(v); err != nil {
			return nil, err
		}
	}
	return &f, nil
}

func toHashes(p [][]byte) []hash32 {
	out := make([]hash32, len(p))
	for i := range p {
		out[i] = hash32(p[i])
	}
	return out
}

func sandboxProofs(ctx context.Context, size uint64) (*client.HTTPFetcher, *client.ProofBuilder, error) {
	u, err := url.Parse(sandboxURL)
	if err != nil {
		return nil, nil, err
	}
	f, err := client.NewHTTPFetcher(u, &http.Client{Timeout: 30 * time.Second})
	if err != nil {
		return nil, nil, err
	}
	pb, err := client.NewProofBuilder(ctx, size, f.ReadTile)
	return f, pb, err
}

// sandboxRoot is the root of the sandbox log at size m, from the tiles of
// its tree at size n: Tessera keeps only the latest partial tile.
func sandboxRoot(ctx context.Context, f *client.HTTPFetcher, m, n uint64) (hash32, error) {
	leaves, err := client.FetchLeafHashes(ctx, f.ReadTile, 0, m, n)
	if err != nil {
		return hash32{}, err
	}
	var t tree
	for i, l := range leaves {
		s, err := tlog.StoredHashesForRecordHash(int64(i), tlog.Hash(l), t)
		if err != nil {
			return hash32{}, err
		}
		t = append(t, s...)
	}
	return hash32(t.root(m)), nil
}

// readNote parses the checkpoint body of a signed note without checking its
// signatures: the legs check them before they sign.
func readNote(path string) (torchwood.Checkpoint, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return torchwood.Checkpoint{}, err
	}
	text, _, ok := strings.Cut(string(b), "\n\n")
	if !ok {
		return torchwood.Checkpoint{}, fmt.Errorf("%s is not a signed note", path)
	}
	return torchwood.ParseCheckpoint(text + "\n")
}

func conformanceSigner() (note.Signer, error) {
	k := os.Getenv("LOG_SIGNER_KEY_CONFORMANCE")
	if k == "" {
		return nil, errors.New("LOG_SIGNER_KEY_CONFORMANCE is not set")
	}
	return note.NewSigner(k)
}

type checkpointCase struct {
	ConsistencyFromPrevious []hash32 `json:"consistencyFromPrevious"`
	Name                    string   `json:"name"`
	Origin                  string   `json:"origin"`
	OriginHash              string   `json:"originHash"`
	Root                    hash32   `json:"root"`
	SigNitro                string   `json:"sigNitro"`
	SigTdx                  string   `json:"sigTdx"`
	SignedNote              string   `json:"signedNote"`
	Size                    uint64   `json:"size"`
}

type checkpointsFile struct {
	CapturedAt        string            `json:"capturedAt"`
	Cases             []checkpointCase  `json:"cases"`
	ChainID           uint64            `json:"chainId"`
	Signers           map[string]string `json:"signers"`
	VerifyingContract string            `json:"verifyingContract"`
}

type legSignature struct {
	Origin    string `json:"origin"`
	TreeSize  string `json:"tree_size"`
	RootHash  string `json:"root_hash"`
	ChainID   uint64 `json:"chain_id"`
	Digest    string `json:"digest"`
	Signature string `json:"signature"`
	Signer    string `json:"signer"`
}

func sign(ctx context.Context, leg, signedNote string) (*legSignature, error) {
	base := os.Getenv(leg)
	body, _ := json.Marshal(map[string]string{"signed_note": signedNote})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(base, "/")+"/v1/checkpoint", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("KEELSON_TEE_TOKEN"))
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", leg, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %s: %s", leg, resp.Status, b)
	}
	var s legSignature
	return &s, json.Unmarshal(b, &s)
}

func checkpointVectors(ctx context.Context, notePath string) (*checkpointsFile, error) {
	signer, err := conformanceSigner()
	if err != nil {
		return nil, err
	}
	a, err := readNote(notePath)
	if err != nil {
		return nil, err
	}
	noteA, err := os.ReadFile(notePath)
	if err != nil {
		return nil, err
	}

	t := build(16, conformance.Entry)
	fork := build(16, forked)
	big := build(gasTo, conformance.Entry)
	conf := func(name string, tr tree, n uint64, prev uint64) checkpointCase {
		var p []hash32
		if prev > 0 {
			p = hashes(tr.consistency(prev, n))
		}
		root := tr.root(n)
		return checkpointCase{Name: name, Origin: conformance.Origin, Size: n, Root: hash32(root), ConsistencyFromPrevious: p, SignedNote: string(conformance.SignedCheckpoint(signer, n, root))}
	}
	cases := []checkpointCase{
		{Name: "sandbox", Origin: a.Origin, Size: uint64(a.N), Root: hash32(a.Hash), ConsistencyFromPrevious: []hash32{}, SignedNote: string(noteA)},
		conf("conformance-8", t, 8, 0),
		conf("conformance-16", t, 16, 8),
		conf("fork-8", fork, 8, 0),
		conf("fork-16", fork, 16, 8),
		conf("conformance-gas-from", big, gasFrom, 0),
		conf("conformance-gas-to", big, gasTo, gasFrom),
	}
	out := &checkpointsFile{
		CapturedAt:        time.Now().UTC().Format(time.RFC3339),
		ChainID:           421614,
		VerifyingContract: os.Getenv("KEELSON_VERIFYING_CONTRACT"),
		Signers:           map[string]string{},
	}
	for i := range cases {
		c := &cases[i]
		if c.ConsistencyFromPrevious == nil {
			c.ConsistencyFromPrevious = []hash32{}
		}
		for _, leg := range []struct{ env, kind string }{{"TEE_A_URL", "tdx"}, {"TEE_B_URL", "nitro"}} {
			s, err := sign(ctx, leg.env, c.SignedNote)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", c.Name, err)
			}
			if s.RootHash != "0x"+hex.EncodeToString(c.Root[:]) || s.TreeSize != strconv.FormatUint(c.Size, 10) {
				return nil, fmt.Errorf("%s: %s signed another checkpoint", c.Name, leg.kind)
			}
			if prev, ok := out.Signers[leg.kind]; ok && prev != s.Signer {
				return nil, fmt.Errorf("%s: the %s signer changed during the capture", c.Name, leg.kind)
			}
			out.Signers[leg.kind] = s.Signer
			c.OriginHash = s.Origin
			if leg.kind == "tdx" {
				c.SigTdx = s.Signature
			} else {
				c.SigNitro = s.Signature
			}
		}
	}
	out.Cases = cases
	return out, nil
}

type statementLeaf struct {
	Index    uint64   `json:"index"`
	Leaf     hexBytes `json:"leaf"`
	LeafHash hash32   `json:"leafHash"`
	Proof    []hash32 `json:"proof"`
}

type hexBytes []byte

func (b hexBytes) MarshalJSON() ([]byte, error) { return json.Marshal("0x" + hex.EncodeToString(b)) }

type statementFile struct {
	Leaves []statementLeaf `json:"leaves"`
	Root   hash32          `json:"root"`
	Size   uint64          `json:"size"`
}

// statementVectors is a log of two real v1 leaves and six SCITT statement leaves (purchase, card
// decision, settlement, bridge) with every leaf's RFC 6962 inclusion proof.
func statementVectors(root string) (*statementFile, error) {
	var leaves [][]byte
	for _, id := range []string{"01M6ZWZJHWRRHQEYNJAT7NMSV8", "01M6ZX07MFWDDDW4199FDJHWEG"} {
		raw, err := os.ReadFile(filepath.Join(root, "packages/alibi/test/fixtures", id+".alibi"))
		if err != nil {
			return nil, err
		}
		var b struct {
			Leaf []byte `json:"leaf"`
		}
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, err
		}
		leaves = append(leaves, b.Leaf)
	}
	for _, name := range []string{"allow-2of2", "allow-degraded", "card-2of2", "card-auth-approve", "card-settlement", "bridge-degraded"} {
		raw, err := os.ReadFile(filepath.Join(root, "internal/alibilog/testdata/statement-v2", name+".json"))
		if err != nil {
			return nil, err
		}
		var v struct {
			StatementHex string `json:"statement_hex"`
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		leaf, err := hex.DecodeString(v.StatementHex)
		if err != nil {
			return nil, err
		}
		leaves = append(leaves, leaf)
	}
	n := uint64(len(leaves))
	t := build(n, func(i uint64) []byte { return leaves[i] })
	out := &statementFile{Root: hash32(t.root(n)), Size: n}
	for i, leaf := range leaves {
		v := statementLeaf{Index: uint64(i), Leaf: leaf, LeafHash: hash32(tlog.RecordHash(leaf)), Proof: hashes(t.inclusion(uint64(i), n))}
		if err := checkInclusion(inclusionVector{Index: v.Index, LeafHash: v.LeafHash, OK: true, Proof: v.Proof, Root: out.Root, Size: n}); err != nil {
			return nil, err
		}
		out.Leaves = append(out.Leaves, v)
	}
	return out, nil
}
