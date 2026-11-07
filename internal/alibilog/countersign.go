package alibilog

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"regexp"

	"golang.org/x/crypto/sha3"
)

// Countersign is the EIP-712 message both TEE legs sign.
type Countersign struct {
	RequestID         [32]byte
	MandateHash       [32]byte
	MandateCommitment [32]byte
	CartHash          [32]byte
	AgentID           *big.Int
	MerchantID        [32]byte
	Amount            uint64
	Currency          uint16
	Category          uint8
	EvidenceRoot      [32]byte
	EvalHash          [32]byte
	PolicySetHash     [32]byte
	Decision          uint8
	FailedFieldsMask  uint32
	IssuedAt          uint64 // uint40
	ExpiresAt         uint64 // uint40
}

const countersignType = "Countersign(bytes32 requestId,bytes32 mandateHash,bytes32 mandateCommitment," +
	"bytes32 cartHash,uint256 agentId,bytes32 merchantId,uint64 amount,uint16 currency,uint8 category," +
	"bytes32 evidenceRoot,bytes32 evalHash,bytes32 policySetHash,uint8 decision,uint32 failedFieldsMask," +
	"uint40 issuedAt,uint40 expiresAt)"

const domainType = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"

func keccak(parts ...[]byte) (out [32]byte) {
	h := sha3.NewLegacyKeccak256()
	for _, p := range parts {
		h.Write(p)
	}
	h.Sum(out[:0])
	return out
}

func word(v uint64) []byte {
	var w [32]byte
	binary.BigEndian.PutUint64(w[24:], v)
	return w[:]
}

var (
	countersignTypeHash = keccak([]byte(countersignType))
	domainTypeHash      = keccak([]byte(domainType))
	nameHash            = keccak([]byte("Keelson"))
	versionHash         = keccak([]byte("1"))
)

// Digest is the EIP-712 signing hash of c under the domain
// {name: "Keelson", version: "1", chainId, verifyingContract}.
func Digest(c Countersign, chainID uint64, verifyingContract [20]byte) [32]byte {
	var contract [32]byte
	copy(contract[12:], verifyingContract[:])
	domain := keccak(domainTypeHash[:], nameHash[:], versionHash[:], word(chainID), contract[:])

	var agent [32]byte
	if c.AgentID != nil {
		c.AgentID.FillBytes(agent[:])
	}
	s := keccak(
		countersignTypeHash[:],
		c.RequestID[:], c.MandateHash[:], c.MandateCommitment[:], c.CartHash[:],
		agent[:], c.MerchantID[:],
		word(c.Amount), word(uint64(c.Currency)), word(uint64(c.Category)),
		c.EvidenceRoot[:], c.EvalHash[:], c.PolicySetHash[:],
		word(uint64(c.Decision)), word(uint64(c.FailedFieldsMask)),
		word(c.IssuedAt), word(c.ExpiresAt),
	)
	return keccak([]byte{0x19, 0x01}, domain[:], s[:])
}

// countersignJSON is the shape the API returns: 0x hex for bytes32 and decimal
// strings for integers.
type countersignJSON struct {
	RequestID         string `json:"requestId"`
	MandateHash       string `json:"mandateHash"`
	MandateCommitment string `json:"mandateCommitment"`
	CartHash          string `json:"cartHash"`
	AgentID           string `json:"agentId"`
	MerchantID        string `json:"merchantId"`
	Amount            string `json:"amount"`
	Currency          string `json:"currency"`
	Category          string `json:"category"`
	EvidenceRoot      string `json:"evidenceRoot"`
	EvalHash          string `json:"evalHash"`
	PolicySetHash     string `json:"policySetHash"`
	Decision          string `json:"decision"`
	FailedFieldsMask  string `json:"failedFieldsMask"`
	IssuedAt          string `json:"issuedAt"`
	ExpiresAt         string `json:"expiresAt"`
}

var bytes32RE = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)

func parseBytes32(dst *[32]byte, s, name string) error {
	if !bytes32RE.MatchString(s) {
		return fmt.Errorf("%s is not a bytes32", name)
	}
	_, err := hex.Decode(dst[:], []byte(s[2:]))
	return err
}

func parseUint(s, name string, bits uint) (uint64, error) {
	if !decimalRE.MatchString(s) {
		return 0, fmt.Errorf("%s is not a decimal", name)
	}
	v, ok := new(big.Int).SetString(s, 10)
	if !ok || v.BitLen() > int(bits) {
		return 0, fmt.Errorf("%s is out of range for uint%d", name, bits)
	}
	return v.Uint64(), nil
}

// UnmarshalJSON decodes the API's string form, strictly.
func (c *Countersign) UnmarshalJSON(b []byte) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var w countersignJSON
	if err := dec.Decode(&w); err != nil {
		return err
	}
	var out Countersign
	for _, f := range []struct {
		dst  *[32]byte
		s    string
		name string
	}{
		{&out.RequestID, w.RequestID, "requestId"},
		{&out.MandateHash, w.MandateHash, "mandateHash"},
		{&out.MandateCommitment, w.MandateCommitment, "mandateCommitment"},
		{&out.CartHash, w.CartHash, "cartHash"},
		{&out.MerchantID, w.MerchantID, "merchantId"},
		{&out.EvidenceRoot, w.EvidenceRoot, "evidenceRoot"},
		{&out.EvalHash, w.EvalHash, "evalHash"},
		{&out.PolicySetHash, w.PolicySetHash, "policySetHash"},
	} {
		if err := parseBytes32(f.dst, f.s, f.name); err != nil {
			return err
		}
	}
	if !decimalRE.MatchString(w.AgentID) {
		return fmt.Errorf("agentId is not a decimal")
	}
	out.AgentID, _ = new(big.Int).SetString(w.AgentID, 10)
	if out.AgentID.BitLen() > 256 {
		return fmt.Errorf("agentId is out of range for uint256")
	}
	var err error
	var v uint64
	if out.Amount, err = parseUint(w.Amount, "amount", 64); err != nil {
		return err
	}
	if v, err = parseUint(w.Currency, "currency", 16); err != nil {
		return err
	}
	out.Currency = uint16(v)
	if v, err = parseUint(w.Category, "category", 8); err != nil {
		return err
	}
	out.Category = uint8(v)
	if v, err = parseUint(w.Decision, "decision", 8); err != nil {
		return err
	}
	out.Decision = uint8(v)
	if v, err = parseUint(w.FailedFieldsMask, "failedFieldsMask", 32); err != nil {
		return err
	}
	out.FailedFieldsMask = uint32(v)
	if out.IssuedAt, err = parseUint(w.IssuedAt, "issuedAt", 40); err != nil {
		return err
	}
	if out.ExpiresAt, err = parseUint(w.ExpiresAt, "expiresAt", 40); err != nil {
		return err
	}
	*c = out
	return nil
}

// MarshalJSON encodes the API's string form.
func (c Countersign) MarshalJSON() ([]byte, error) {
	h := func(b [32]byte) string { return "0x" + hex.EncodeToString(b[:]) }
	d := func(v uint64) string { return fmt.Sprint(v) }
	agent := "0"
	if c.AgentID != nil {
		agent = c.AgentID.String()
	}
	return json.Marshal(countersignJSON{
		RequestID: h(c.RequestID), MandateHash: h(c.MandateHash),
		MandateCommitment: h(c.MandateCommitment), CartHash: h(c.CartHash),
		AgentID: agent, MerchantID: h(c.MerchantID), Amount: d(c.Amount),
		Currency: d(uint64(c.Currency)), Category: d(uint64(c.Category)),
		EvidenceRoot: h(c.EvidenceRoot), EvalHash: h(c.EvalHash), PolicySetHash: h(c.PolicySetHash),
		Decision: d(uint64(c.Decision)), FailedFieldsMask: d(uint64(c.FailedFieldsMask)),
		IssuedAt: d(c.IssuedAt), ExpiresAt: d(c.ExpiresAt),
	})
}
