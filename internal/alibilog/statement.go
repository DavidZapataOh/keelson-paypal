package alibilog

import (
	"bytes"
	"math/big"
	"time"

	"github.com/fxamacker/cbor/v2"
	cose "github.com/veraison/go-cose"
)

// Leaf kinds.
const (
	KindPurchase          = "purchase"
	KindCardAuthorization = "card-authorization"
	KindCardSettlement    = "card-settlement"
	KindBridge            = "bridge"
)

// Statement constants shared with the TypeScript and Rust encoders.
const (
	ClaimsContentType = "application/vnd.keelson.alibi-claims+cbor"
	BridgeContentType = "application/vnd.keelson.alibi-bridge-claims+cbor"
	StatementIssuer   = "https://keelson.finance"
)

var (
	strictDec, _ = cbor.DecOptions{
		DupMapKey:   cbor.DupMapKeyEnforcedAPF,
		IndefLength: cbor.IndefLengthForbidden,
		IntDec:      cbor.IntDecConvertSigned,
	}.DecMode()
	detEnc, _ = cbor.CoreDetEncOptions().EncMode()
)

// decodeStrict decodes CBOR only if it is the core deterministic encoding of its value.
func decodeStrict(b []byte, what string) (any, error) {
	var v any
	if err := strictDec.Unmarshal(b, &v); err != nil {
		return nil, leafErr("leaf.noncanonical", "%s: %v", what, err)
	}
	again, err := detEnc.Marshal(v)
	if err != nil || !bytes.Equal(again, b) {
		return nil, leafErr("leaf.noncanonical", "%s is not in deterministic form", what)
	}
	return v, nil
}

func intKeyed(v any, what string) (map[int64]any, error) {
	m, ok := v.(map[any]any)
	if !ok {
		return nil, leafErr("leaf.format", "%s is not a map", what)
	}
	out := make(map[int64]any, len(m))
	for k, x := range m {
		i, ok := k.(int64)
		if !ok {
			return nil, leafErr("leaf.unknown", "%s key %v", what, k)
		}
		out[i] = x
	}
	return out, nil
}

func fixedBytes(m map[int64]any, k int64, n int, name string) ([]byte, error) {
	b, ok := m[k].([]byte)
	if !ok || len(b) != n {
		return nil, leafErr("leaf.field", "%s is not %d bytes", name, n)
	}
	return b, nil
}

func uintField(m map[int64]any, k int64, name string, bits uint) (uint64, error) {
	i, ok := m[k].(int64)
	if !ok || i < 0 || (bits < 64 && uint64(i) >= 1<<bits) {
		return 0, leafErr("leaf.field", "%s is not a uint%d", name, bits)
	}
	return uint64(i), nil
}

// bigUint reads a uint256: an integer, or a tag 2 bignum above 2^63-1.
func bigUint(v any, name string) (*big.Int, error) {
	switch x := v.(type) {
	case int64:
		if x >= 0 {
			return big.NewInt(x), nil
		}
	case big.Int:
		if x.Sign() >= 0 && x.BitLen() <= 256 {
			return &x, nil
		}
	case *big.Int:
		if x.Sign() >= 0 && x.BitLen() <= 256 {
			return x, nil
		}
	}
	return nil, leafErr("leaf.field", "%s is not a uint256", name)
}

var (
	purchaseKeys = keySet(1, 22)
	bridgeKeys   = keySet(1, 21, 23)
)

func keySet(from, to int64, extra ...int64) map[int64]bool {
	s := map[int64]bool{}
	for k := from; k <= to; k++ {
		s[k] = true
	}
	for _, k := range extra {
		s[k] = true
	}
	return s
}

type signedParts struct {
	chainID           uint64
	verifyingContract [20]byte
	mode              string
	signers           [][20]byte
	sigs              [][65]byte
	measurements      [][32]byte
}

func parseSigned(m map[int64]any) (*signedParts, error) {
	p := &signedParts{}
	var err error
	if p.chainID, err = uintField(m, 18, "chainId", 64); err != nil {
		return nil, err
	}
	vc, err := fixedBytes(m, 19, 20, "verifyingContract")
	if err != nil {
		return nil, err
	}
	p.verifyingContract = [20]byte(vc)
	switch mode, _ := m[20].(int64); mode {
	case 1:
		p.mode = Mode2of2
	case 2:
		p.mode = ModeDegraded
	default:
		return nil, leafErr("leaf.field", "mode")
	}
	legs, ok := m[21].([]any)
	if !ok {
		return nil, leafErr("leaf.field", "legs")
	}
	kinds := ""
	for i, raw := range legs {
		leg, ok := raw.([]any)
		if !ok || len(leg) != 4 {
			return nil, leafErr("leaf.field", "leg %d", i)
		}
		kind, _ := leg[0].(int64)
		signer, ok1 := leg[1].([]byte)
		sig, ok2 := leg[2].([]byte)
		meas, ok3 := leg[3].([]byte)
		if (kind != 1 && kind != 2) || !ok1 || !ok2 || !ok3 || len(signer) != 20 || len(sig) != 65 || len(meas) != 32 {
			return nil, leafErr("leaf.field", "leg %d", i)
		}
		kinds += map[int64]string{1: "tdx,", 2: "nitro,"}[kind]
		p.signers = append(p.signers, [20]byte(signer))
		p.sigs = append(p.sigs, [65]byte(sig))
		p.measurements = append(p.measurements, [32]byte(meas))
	}
	if (p.mode == Mode2of2 && kinds != "tdx,nitro,") || (p.mode == ModeDegraded && kinds != "tdx,") {
		return nil, leafErr("leaf.mode", "%s with legs %s", p.mode, kinds)
	}
	return p, nil
}

// ParseAny parses a v1 leaf or a v2 signed statement, by its first byte.
func ParseAny(leaf []byte) (*Leaf, error) {
	if len(leaf) > 0 && leaf[0] == 0xd2 {
		return ParseStatement(leaf)
	}
	return Parse(leaf)
}

// ParseStatement parses a v2 leaf: a SCITT signed statement (RFC 9943) with an empty unprotected
// header, whose payload's legs signed one EIP-712 digest and whose ES256K signature is by the leg
// its mode names: Nitro in 2of2, TDX when degraded.
func ParseStatement(leaf []byte) (*Leaf, error) {
	if len(leaf) > MaxLeafBytes {
		return nil, leafErr("leaf.size", "%d bytes", len(leaf))
	}
	v, err := decodeStrict(leaf, "the statement")
	if err != nil {
		return nil, err
	}
	tag, ok := v.(cbor.Tag)
	body, ok2 := tag.Content.([]any)
	if !ok || tag.Number != 18 || !ok2 || len(body) != 4 {
		return nil, leafErr("leaf.format", "not a tagged COSE_Sign1")
	}
	protected, ok1 := body[0].([]byte)
	unprotected, ok2 := body[1].(map[any]any)
	payload, ok3 := body[2].([]byte)
	if !ok1 || !ok2 || !ok3 {
		return nil, leafErr("leaf.format", "COSE_Sign1 fields")
	}
	if len(unprotected) != 0 {
		return nil, leafErr("leaf.unprotected", "a logged statement has no unprotected header")
	}

	hv, err := decodeStrict(protected, "the protected header")
	if err != nil {
		return nil, err
	}
	h, err := intKeyed(hv, "the protected header")
	if err != nil {
		return nil, err
	}
	if len(h) != 4 || h[1] != int64(AlgorithmES256K) {
		return nil, leafErr("leaf.format", "protected header labels or algorithm")
	}
	kind := map[any]string{
		ClaimsContentType:            KindPurchase,
		CardAuthorizationContentType: KindCardAuthorization,
		CardSettlementContentType:    KindCardSettlement,
		BridgeContentType:            KindBridge,
	}[h[3]]
	if kind == "" {
		return nil, leafErr("leaf.format", "not an Alibi statement content type")
	}
	kid, ok := h[4].([]byte)
	if !ok || len(kid) != 20 {
		return nil, leafErr("leaf.format", "kid is not an address")
	}
	cwt, err := intKeyed(h[15], "the CWT claims")
	if err != nil {
		return nil, err
	}
	sub, _ := cwt[2].(string)
	iat, _ := cwt[6].(int64)
	if cwt[1] != StatementIssuer || sub == "" || len(cwt) != 3 {
		return nil, leafErr("leaf.format", "CWT claims")
	}

	cv, err := decodeStrict(payload, "the claims")
	if err != nil {
		return nil, err
	}
	m, err := intKeyed(cv, "the claims")
	if err != nil {
		return nil, err
	}
	allowed := map[string]map[int64]bool{
		KindPurchase:          purchaseKeys,
		KindCardAuthorization: cardAuthorizationKeys,
		KindCardSettlement:    cardSettlementKeys,
		KindBridge:            bridgeKeys,
	}[kind]
	for k := range m {
		if !allowed[k] {
			return nil, leafErr("leaf.unknown", "claim %d", k)
		}
	}
	if m[1] != int64(2) {
		return nil, leafErr("leaf.field", "claims version")
	}
	signed, err := parseSigned(m)
	if err != nil {
		return nil, err
	}

	l := &Leaf{
		Version:           2,
		Kind:              kind,
		Mode:              signed.mode,
		TeeSigs:           signed.sigs,
		Measurements:      signed.measurements,
		ChainID:           signed.chainID,
		VerifyingContract: signed.verifyingContract,
	}
	var digest [32]byte
	var requestID [32]byte
	var issuedAt uint64
	switch kind {
	case KindPurchase, KindBridge:
		c, err := purchaseCountersign(m)
		if err != nil {
			return nil, err
		}
		l.Countersign = c
		l.AgentID = c.AgentID
		l.MandateHash, l.MandateCommitment, l.CartHash = c.MandateHash, c.MandateCommitment, c.CartHash
		l.EvidenceRoot, l.EvalHash, l.PolicySetHash = c.EvidenceRoot, c.EvalHash, c.PolicySetHash
		if _, present := m[22]; present {
			r, err := fixedBytes(m, 22, 32, "payRef")
			if err != nil {
				return nil, err
			}
			l.PaypalRefCommit = [32]byte(r)
		}
		if kind == KindBridge {
			p, err := fixedBytes(m, 23, 32, "predecessor")
			if err != nil {
				return nil, err
			}
			pred := [32]byte(p)
			l.Predecessor = &pred
		}
		digest = Digest(*c, signed.chainID, signed.verifyingContract)
		requestID, issuedAt = c.RequestID, c.IssuedAt
	default:
		digest, requestID, issuedAt, err = parseCard(kind, m, l, signed)
		if err != nil {
			return nil, err
		}
	}
	l.CountersignDigest = digest
	l.IssuedAt = time.Unix(int64(issuedAt), 0).UTC()

	id, err := ulidFromBytes32(requestID)
	if err != nil || id != sub {
		return nil, leafErr("leaf.field", "sub is not the request id")
	}
	l.AlibiID = sub
	if iat < 0 || uint64(iat) != issuedAt {
		return nil, leafErr("leaf.field", "iat")
	}
	// A bridge is signed by leg A's current signer, which admission checks against the registry.
	expected := signed.signers[len(signed.signers)-1]
	if kind == KindBridge {
		expected = [20]byte(kid)
	}
	if [20]byte(kid) != expected {
		return nil, leafErr("leaf.signer", "the statement is signed by %x, not the %s leg's signer", kid, map[string]string{Mode2of2: "nitro", ModeDegraded: "tdx"}[signed.mode])
	}
	l.StatementSigner = expected
	var msg cose.Sign1Message
	if err := msg.UnmarshalCBOR(leaf); err != nil {
		return nil, leafErr("leaf.format", "%v", err)
	}
	if err := msg.Verify(nil, ES256KVerifier(expected)); err != nil {
		return nil, leafErr("leaf.signature", "the statement signature does not verify")
	}
	for i, sig := range signed.sigs {
		addr, err := Recover(digest, sig)
		if err != nil || addr != signed.signers[i] {
			return nil, leafErr("leaf.digest", "leg %d did not sign these facts", i)
		}
	}
	return l, nil
}

func purchaseCountersign(m map[int64]any) (*Countersign, error) {
	c := &Countersign{}
	for _, f := range []struct {
		k    int64
		dst  *[32]byte
		name string
	}{
		{2, &c.RequestID, "requestId"}, {3, &c.MandateHash, "mandateHash"},
		{4, &c.MandateCommitment, "mandateCommitment"}, {5, &c.CartHash, "cartHash"},
		{7, &c.MerchantID, "merchantId"}, {11, &c.EvidenceRoot, "evidenceRoot"},
		{12, &c.EvalHash, "evalHash"}, {13, &c.PolicySetHash, "policySetHash"},
	} {
		b, err := fixedBytes(m, f.k, 32, f.name)
		if err != nil {
			return nil, err
		}
		*f.dst = [32]byte(b)
	}
	var err error
	if c.AgentID, err = bigUint(m[6], "agentId"); err != nil {
		return nil, err
	}
	u := func(k int64, name string, bits uint) uint64 {
		if err != nil {
			return 0
		}
		var v uint64
		v, err = uintField(m, k, name, bits)
		return v
	}
	c.Amount = u(8, "amount", 64)
	c.Currency = uint16(u(9, "currency", 16))
	c.Category = uint8(u(10, "category", 8))
	c.Decision = uint8(u(14, "decision", 8))
	c.FailedFieldsMask = uint32(u(15, "failedFieldsMask", 32))
	c.IssuedAt = u(16, "issuedAt", 40)
	c.ExpiresAt = u(17, "expiresAt", 40)
	if err != nil {
		return nil, err
	}
	return c, nil
}
