package alibilog

// Card statement content types and claim keys; the parsing lands with the card statements.
const (
	CardAuthorizationContentType = "application/vnd.keelson.card-authorization-claims+cbor"
	CardSettlementContentType    = "application/vnd.keelson.card-settlement-claims+cbor"
)

var (
	cardAuthorizationKeys = keySet(1, 14, 18, 19, 20, 21)
	cardSettlementKeys    = keySet(1, 9, 14, 18, 19, 20, 21)
)

func parseCard(kind string, m map[int64]any, l *Leaf, signed *signedParts) ([32]byte, [32]byte, uint64, error) {
	return [32]byte{}, [32]byte{}, 0, leafErr("leaf.format", "%s statements are not parsed yet", kind)
}
