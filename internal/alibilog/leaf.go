// Package alibilog defines the Alibi leaf the Keelson log admits and checks the
// TEE countersignature it carries.
package alibilog

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"time"
)

// Prefix is the domain prefix of every leaf.
const Prefix = "keelson.finance/alibi/v1\n"

// MaxLeafBytes is the largest leaf the log admits.
const MaxLeafBytes = 1024

// Leaf modes. A degraded leaf was countersigned by the TDX leg alone.
const (
	Mode2of2     = "2of2"
	ModeDegraded = "degraded"
)

// LeafError reports why a leaf was refused. Code is one of leaf.prefix,
// leaf.size, leaf.field, leaf.mode, leaf.unknown and leaf.noncanonical.
type LeafError struct {
	Code   string
	Detail string
}

func (e *LeafError) Error() string { return e.Code + ": " + e.Detail }

func leafErr(code, format string, args ...any) error {
	return &LeafError{Code: code, Detail: fmt.Sprintf(format, args...)}
}

// Leaf is a parsed Alibi leaf.
type Leaf struct {
	AlibiID           string
	MandateHash       [32]byte
	MandateCommitment [32]byte
	CartHash          [32]byte
	EvidenceRoot      [32]byte
	EvalHash          [32]byte
	PolicySetHash     [32]byte
	CountersignDigest [32]byte
	PaypalRefCommit   [32]byte
	Mode              string
	// TeeSigs is [tdx, nitro] for 2of2 and [tdx] for degraded.
	TeeSigs [][65]byte
	// Measurements has the order and count of TeeSigs.
	Measurements    [][32]byte
	AgentID         *big.Int
	IssuedAt        time.Time
	PrevAlibiByUser *[32]byte

	// Version is 1 for a JCS leaf and 2 for a signed statement.
	Version int
	// Kind is KindPurchase, KindCardAuthorization or KindCardSettlement.
	Kind string
	// StatementSigner is the leg whose key signed a v2 statement.
	StatementSigner [20]byte
	// Countersign holds every countersigned field of a v2 purchase statement.
	Countersign       *Countersign
	ChainID           uint64
	VerifyingContract [20]byte
	// Predecessor is the v1 leaf hash a bridge statement carries into v2.
	Predecessor *[32]byte
	// Parent is the purchase leaf hash a card statement links to.
	Parent *[32]byte
	// CardRef is a card statement's commitment to the issuer and card token.
	CardRef       *[32]byte
	Authorization *CardAuthorization
	Settlement    *CardSettlement
}

// wire is the JSON body. Its fields are in RFC 8785 key order and every value
// is ASCII from a fixed alphabet, so encoding/json writes the canonical form.
type wire struct {
	AgentID           string   `json:"agent_id"`
	AlibiID           string   `json:"alibi_id"`
	CartHash          string   `json:"cart_hash"`
	CountersignDigest string   `json:"countersign_digest"`
	EvalHash          string   `json:"eval_hash"`
	EvidenceRoot      string   `json:"evidence_root"`
	IssuedAt          string   `json:"issued_at"`
	MandateCommitment string   `json:"mandate_commitment"`
	MandateHash       string   `json:"mandate_hash"`
	Measurements      []string `json:"measurements"`
	Mode              *string  `json:"mode"`
	PaypalRefCommit   string   `json:"paypal_ref_commit"`
	PolicySetHash     string   `json:"policy_set_hash"`
	PrevAlibiByUser   string   `json:"prev_alibi_by_user,omitempty"`
	TeeSigs           []string `json:"tee_sigs"`
}

var (
	ulidRE     = regexp.MustCompile(`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`)
	decimalRE  = regexp.MustCompile(`^(0|[1-9][0-9]{0,77})$`)
	maxUint256 = new(big.Int).Lsh(big.NewInt(1), 256)
)

const rfc3339Seconds = "2006-01-02T15:04:05Z"

func b64(dst []byte, s, field string) error {
	b, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil || len(b) != len(dst) {
		return leafErr("leaf.field", "%s is not %d bytes of base64url", field, len(dst))
	}
	copy(dst, b)
	return nil
}

// Parse decodes a leaf, requiring the prefix, the exact format of every field,
// signature and measurement counts that match the mode, and the canonical
// encoding, byte for byte.
func Parse(leaf []byte) (*Leaf, error) {
	if !bytes.HasPrefix(leaf, []byte(Prefix)) {
		return nil, leafErr("leaf.prefix", "missing %q", strings.TrimSpace(Prefix))
	}
	if len(leaf) > MaxLeafBytes {
		return nil, leafErr("leaf.size", "%d bytes", len(leaf))
	}
	body := leaf[len(Prefix):]
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var w wire
	if err := dec.Decode(&w); err != nil {
		if strings.Contains(err.Error(), "unknown field") {
			return nil, leafErr("leaf.unknown", "%v", err)
		}
		return nil, leafErr("leaf.noncanonical", "%v", err)
	}

	l := &Leaf{Version: 1, Kind: KindPurchase}
	if w.Mode == nil {
		return nil, leafErr("leaf.mode", "missing")
	}
	n := 0
	switch *w.Mode {
	case Mode2of2:
		n = 2
	case ModeDegraded:
		n = 1
	default:
		return nil, leafErr("leaf.mode", "unknown mode %q", *w.Mode)
	}
	if len(w.TeeSigs) != n || len(w.Measurements) != n {
		return nil, leafErr("leaf.mode", "%s needs %d signatures and measurements, got %d and %d",
			*w.Mode, n, len(w.TeeSigs), len(w.Measurements))
	}
	l.Mode = *w.Mode

	if !ulidRE.MatchString(w.AlibiID) {
		return nil, leafErr("leaf.field", "alibi_id is not a ULID")
	}
	l.AlibiID = w.AlibiID
	if !decimalRE.MatchString(w.AgentID) {
		return nil, leafErr("leaf.field", "agent_id is not a decimal")
	}
	l.AgentID, _ = new(big.Int).SetString(w.AgentID, 10)
	if l.AgentID.Cmp(maxUint256) >= 0 {
		return nil, leafErr("leaf.field", "agent_id is not a uint256")
	}
	t, err := time.Parse(rfc3339Seconds, w.IssuedAt)
	if err != nil || t.Format(rfc3339Seconds) != w.IssuedAt {
		return nil, leafErr("leaf.field", "issued_at is not RFC 3339 UTC seconds")
	}
	l.IssuedAt = t

	for _, f := range []struct {
		dst  []byte
		s    string
		name string
	}{
		{l.MandateHash[:], w.MandateHash, "mandate_hash"},
		{l.MandateCommitment[:], w.MandateCommitment, "mandate_commitment"},
		{l.CartHash[:], w.CartHash, "cart_hash"},
		{l.EvidenceRoot[:], w.EvidenceRoot, "evidence_root"},
		{l.EvalHash[:], w.EvalHash, "eval_hash"},
		{l.PolicySetHash[:], w.PolicySetHash, "policy_set_hash"},
		{l.CountersignDigest[:], w.CountersignDigest, "countersign_digest"},
		{l.PaypalRefCommit[:], w.PaypalRefCommit, "paypal_ref_commit"},
	} {
		if err := b64(f.dst, f.s, f.name); err != nil {
			return nil, err
		}
	}
	if w.PrevAlibiByUser != "" {
		var p [32]byte
		if err := b64(p[:], w.PrevAlibiByUser, "prev_alibi_by_user"); err != nil {
			return nil, err
		}
		l.PrevAlibiByUser = &p
	}
	l.TeeSigs = make([][65]byte, n)
	l.Measurements = make([][32]byte, n)
	for i := range n {
		if err := b64(l.TeeSigs[i][:], w.TeeSigs[i], "tee_sigs"); err != nil {
			return nil, err
		}
		if err := b64(l.Measurements[i][:], w.Measurements[i], "measurements"); err != nil {
			return nil, err
		}
	}

	canonical, err := json.Marshal(w)
	if err != nil {
		return nil, leafErr("leaf.noncanonical", "%v", err)
	}
	if !bytes.Equal(canonical, body) {
		return nil, leafErr("leaf.noncanonical", "the body is not in canonical form")
	}
	return l, nil
}

// LeafHash is the RFC 6962 leaf hash, SHA-256(0x00 || leaf).
func LeafHash(leaf []byte) [32]byte {
	h := sha256.New()
	h.Write([]byte{0})
	h.Write(leaf)
	var out [32]byte
	h.Sum(out[:0])
	return out
}

// ErrMismatch is returned by Matches when a bound field differs.
var ErrMismatch = errors.New("the leaf does not match the countersign")

// Matches reports whether the leaf carries the fields the countersign binds.
func (l *Leaf) Matches(c Countersign) error {
	id, err := ulidFromBytes32(c.RequestID)
	if err != nil || id != l.AlibiID {
		return fmt.Errorf("%w: requestId", ErrMismatch)
	}
	for _, f := range []struct {
		a, b [32]byte
		name string
	}{
		{l.MandateHash, c.MandateHash, "mandateHash"},
		{l.MandateCommitment, c.MandateCommitment, "mandateCommitment"},
		{l.CartHash, c.CartHash, "cartHash"},
		{l.EvidenceRoot, c.EvidenceRoot, "evidenceRoot"},
		{l.EvalHash, c.EvalHash, "evalHash"},
		{l.PolicySetHash, c.PolicySetHash, "policySetHash"},
	} {
		if f.a != f.b {
			return fmt.Errorf("%w: %s", ErrMismatch, f.name)
		}
	}
	if c.AgentID == nil || l.AgentID.Cmp(c.AgentID) != 0 {
		return fmt.Errorf("%w: agentId", ErrMismatch)
	}
	if uint64(l.IssuedAt.Unix()) != c.IssuedAt {
		return fmt.Errorf("%w: issuedAt", ErrMismatch)
	}
	return nil
}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// ulidFromBytes32 encodes the ULID a bytes32 request id right-aligns.
func ulidFromBytes32(b [32]byte) (string, error) {
	for _, x := range b[:16] {
		if x != 0 {
			return "", errors.New("not a ULID")
		}
	}
	n := new(big.Int).SetBytes(b[16:])
	out := make([]byte, 26)
	for i := 25; i >= 0; i-- {
		out[i] = crockford[n.Uint64()&31]
		n.Rsh(n, 5)
	}
	return string(out), nil
}
