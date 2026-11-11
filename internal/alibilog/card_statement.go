package alibilog

// Card statement content types.
const (
	CardAuthorizationContentType = "application/vnd.keelson.card-authorization-claims+cbor"
	CardSettlementContentType    = "application/vnd.keelson.card-settlement-claims+cbor"
)

var (
	cardAuthorizationKeys = keySet(1, 14, 18, 19, 20, 21)
	cardSettlementKeys    = keySet(1, 9, 14, 18, 19, 20, 21)

	cardAuthorizationTypeHash = keccak([]byte("CardAuthorization(bytes32 requestId,bytes32 countersignDigest," +
		"bytes32 authorizationHash,bytes32 merchantHash,uint16 mcc,bytes2 country,uint64 amount,uint16 currency," +
		"uint8 decision,uint32 failedMask,uint40 issuedAt)"))
	cardSettlementTypeHash = keccak([]byte("CardSettlement(bytes32 requestId,bytes32 cardRef,bytes32 transactionHash," +
		"uint64 settledMinor,uint16 currency,uint8 status,uint40 settledAt,uint40 observedAt)"))
)

// CardAuthorization is the EIP-712 decision both legs sign for one card network authorization.
type CardAuthorization struct {
	RequestID         [32]byte
	CountersignDigest [32]byte
	AuthorizationHash [32]byte
	MerchantHash      [32]byte
	MCC               uint16
	Country           [2]byte
	Amount            uint64
	Currency          uint16
	Decision          uint8
	FailedMask        uint32
	IssuedAt          uint64 // uint40
}

// CardSettlement is the EIP-712 settlement both legs sign after leg A read it from the issuer.
type CardSettlement struct {
	RequestID       [32]byte
	CardRef         [32]byte
	TransactionHash [32]byte
	SettledMinor    uint64
	Currency        uint16
	Status          uint8
	SettledAt       uint64 // uint40
	ObservedAt      uint64 // uint40
}

// Digest is the EIP-712 signing hash of a under the Keelson domain.
func (a CardAuthorization) Digest(chainID uint64, verifyingContract [20]byte) [32]byte {
	var country [32]byte
	copy(country[:], a.Country[:])
	s := keccak(cardAuthorizationTypeHash[:], a.RequestID[:], a.CountersignDigest[:], a.AuthorizationHash[:],
		a.MerchantHash[:], word(uint64(a.MCC)), country[:], word(a.Amount), word(uint64(a.Currency)),
		word(uint64(a.Decision)), word(uint64(a.FailedMask)), word(a.IssuedAt))
	return HashTypedData(s, chainID, verifyingContract)
}

// Digest is the EIP-712 signing hash of s under the Keelson domain.
func (s CardSettlement) Digest(chainID uint64, verifyingContract [20]byte) [32]byte {
	h := keccak(cardSettlementTypeHash[:], s.RequestID[:], s.CardRef[:], s.TransactionHash[:],
		word(s.SettledMinor), word(uint64(s.Currency)), word(uint64(s.Status)), word(s.SettledAt), word(s.ObservedAt))
	return HashTypedData(h, chainID, verifyingContract)
}

// parseCard reads a card statement's facts into l and returns their digest, request id and time.
func parseCard(kind string, m map[int64]any, l *Leaf, signed *signedParts) ([32]byte, [32]byte, uint64, error) {
	var err error
	b32 := func(k int64, name string) (out [32]byte) {
		if err != nil {
			return out
		}
		var b []byte
		if b, err = fixedBytes(m, k, 32, name); err == nil {
			out = [32]byte(b)
		}
		return out
	}
	u := func(k int64, name string, bits uint) uint64 {
		if err != nil {
			return 0
		}
		var v uint64
		v, err = uintField(m, k, name, bits)
		return v
	}
	parent := b32(14, "parent")
	l.Parent = &parent
	if kind == KindCardAuthorization {
		a := CardAuthorization{
			RequestID:         b32(2, "requestId"),
			CountersignDigest: b32(3, "countersignDigest"),
			AuthorizationHash: b32(4, "authorizationHash"),
			MerchantHash:      b32(5, "merchantHash"),
			MCC:               uint16(u(6, "mcc", 16)),
			Amount:            u(8, "amount", 64),
			Currency:          uint16(u(9, "currency", 16)),
			Decision:          uint8(u(10, "decision", 8)),
			FailedMask:        uint32(u(11, "failedMask", 32)),
			IssuedAt:          u(12, "issuedAt", 40),
		}
		ref := b32(13, "cardRef")
		if err == nil {
			var country []byte
			if country, err = fixedBytes(m, 7, 2, "country"); err == nil {
				a.Country = [2]byte(country)
			}
		}
		if err != nil {
			return [32]byte{}, [32]byte{}, 0, err
		}
		l.Authorization, l.CardRef = &a, &ref
		return a.Digest(signed.chainID, signed.verifyingContract), a.RequestID, a.IssuedAt, nil
	}
	s := CardSettlement{
		RequestID:       b32(2, "requestId"),
		CardRef:         b32(3, "cardRef"),
		TransactionHash: b32(4, "transactionHash"),
		SettledMinor:    u(5, "settledMinor", 64),
		Currency:        uint16(u(6, "currency", 16)),
		Status:          uint8(u(7, "status", 8)),
		SettledAt:       u(8, "settledAt", 40),
		ObservedAt:      u(9, "observedAt", 40),
	}
	if err != nil {
		return [32]byte{}, [32]byte{}, 0, err
	}
	l.Settlement, l.CardRef = &s, &s.CardRef
	return s.Digest(signed.chainID, signed.verifyingContract), s.RequestID, s.ObservedAt, nil
}
