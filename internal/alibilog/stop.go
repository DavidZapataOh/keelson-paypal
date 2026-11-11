package alibilog

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"slices"
	"strings"
	"time"
)

// StopPrefix is the domain prefix of a stop leaf: a user stopped every agent at
// once. From its index on, no Alibi leaf may carry a mandate hash it lists.
const StopPrefix = "keelson.finance/stop/v1\n"

// MaxStopMandates is the most mandates one stop names.
const MaxStopMandates = 10_000

// Stop is a parsed stop leaf.
type Stop struct {
	StopID   string
	IssuedAt time.Time
	// MandatesDigest is SHA-256 of the 32-byte hashes of the stopped mandates,
	// sorted and concatenated; see [MandatesDigest].
	MandatesDigest [32]byte
	MandateCount   int
}

// stopWire is the JSON body, in RFC 8785 key order.
type stopWire struct {
	IssuedAt       string `json:"issued_at"`
	MandateCount   *int   `json:"mandate_count"`
	MandatesDigest string `json:"mandates_digest"`
	StopID         string `json:"stop_id"`
}

// IsStop reports whether the leaf claims to be a stop leaf.
func IsStop(leaf []byte) bool { return bytes.HasPrefix(leaf, []byte(StopPrefix)) }

// ParseStop decodes a stop leaf, requiring the prefix, the exact format of
// every field and the canonical encoding, byte for byte.
func ParseStop(leaf []byte) (*Stop, error) {
	if !IsStop(leaf) {
		return nil, leafErr("leaf.prefix", "missing %q", strings.TrimSpace(StopPrefix))
	}
	if len(leaf) > MaxLeafBytes {
		return nil, leafErr("leaf.size", "%d bytes", len(leaf))
	}
	body := leaf[len(StopPrefix):]
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var w stopWire
	if err := dec.Decode(&w); err != nil {
		if strings.Contains(err.Error(), "unknown field") {
			return nil, leafErr("leaf.unknown", "%v", err)
		}
		return nil, leafErr("leaf.noncanonical", "%v", err)
	}
	s := &Stop{}
	if !ulidRE.MatchString(w.StopID) {
		return nil, leafErr("leaf.field", "stop_id is not a ULID")
	}
	s.StopID = w.StopID
	t, err := time.Parse(rfc3339Seconds, w.IssuedAt)
	if err != nil || t.Format(rfc3339Seconds) != w.IssuedAt {
		return nil, leafErr("leaf.field", "issued_at is not RFC 3339 UTC seconds")
	}
	s.IssuedAt = t
	if w.MandateCount == nil || *w.MandateCount < 0 || *w.MandateCount > MaxStopMandates {
		return nil, leafErr("leaf.field", "mandate_count is not 0 to %d", MaxStopMandates)
	}
	s.MandateCount = *w.MandateCount
	if err := b64(s.MandatesDigest[:], w.MandatesDigest, "mandates_digest"); err != nil {
		return nil, err
	}
	canonical, err := json.Marshal(w)
	if err != nil {
		return nil, leafErr("leaf.noncanonical", "%v", err)
	}
	if !bytes.Equal(canonical, body) {
		return nil, leafErr("leaf.noncanonical", "the body is not in canonical form")
	}
	return s, nil
}

// MandatesDigest is the digest a stop leaf commits to: SHA-256 of the mandate
// hashes sorted bytewise and concatenated, repeats dropped.
func MandatesDigest(hashes [][32]byte) [32]byte {
	sorted := slices.Clone(hashes)
	slices.SortFunc(sorted, func(a, b [32]byte) int { return bytes.Compare(a[:], b[:]) })
	sorted = slices.Compact(sorted)
	h := sha256.New()
	for _, m := range sorted {
		h.Write(m[:])
	}
	var out [32]byte
	h.Sum(out[:0])
	return out
}
