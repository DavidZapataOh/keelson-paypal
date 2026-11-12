package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/DavidZapataOh/keelson-paypal/internal/alibilog"
)

// admitError is a refusal with a stable code; nothing is appended.
type admitError struct{ Code string }

func (e *admitError) Error() string { return e.Code }

func refuse(code string) error { return &admitError{Code: code} }

// admit checks that leaf is a well-formed Alibi leaf bound to c, that the
// registered TEE signers its mode requires signed c, and that its mode is the
// one the API recorded for the purchase. Errors other than *admitError and
// *alibilog.LeafError are the registry's.
func (o *origin) admit(ctx context.Context, reg registry, leaf []byte, c alibilog.Countersign) error {
	l, err := alibilog.ParseAny(leaf)
	if err != nil {
		return err
	}
	if l.Version == 2 && (l.ChainID != o.chainID || l.VerifyingContract != o.verifyingContract) {
		return refuse("countersign.digest")
	}
	purchaseDigest := alibilog.Digest(c, o.chainID, o.verifyingContract)
	switch l.Kind {
	case alibilog.KindPurchase, alibilog.KindBridge:
		if purchaseDigest != l.CountersignDigest {
			return refuse("countersign.digest")
		}
		if l.Matches(c) != nil {
			return refuse("countersign.fields")
		}
	case alibilog.KindCardAuthorization:
		if l.Authorization.CountersignDigest != purchaseDigest {
			return refuse("countersign.digest")
		}
	}
	if l.Kind != alibilog.KindPurchase {
		if err := o.admitLinked(ctx, reg, l); err != nil {
			return err
		}
	}

	kinds := []int{teeTDX, teeNitro}[:len(l.TeeSigs)]
	seen := map[[20]byte]bool{}
	for i, sig := range l.TeeSigs {
		addr, err := alibilog.Recover(l.CountersignDigest, sig)
		if err != nil {
			return refuse("countersign.signature")
		}
		if seen[addr] {
			return refuse("countersign.signer")
		}
		seen[addr] = true
		m, ok, err := reg.Active(ctx, kinds[i], addr, l.IssuedAt)
		if err != nil {
			return err
		}
		if !ok {
			return refuse("countersign.signer")
		}
		if m != measurementID(kinds[i], l.Measurements[i]) {
			return refuse("countersign.measurement")
		}
	}

	mode, ok, err := reg.PurchaseMode(ctx, l.AlibiID)
	if err != nil {
		return err
	}
	if !ok || mode != l.Mode {
		return refuse("countersign.mode")
	}
	return nil
}

// admitLinked checks what links a card or bridge statement to its purchase: the purchase leaf the
// log already holds, and, for a bridge, that leg A's current signer signed it.
func (o *origin) admitLinked(ctx context.Context, reg registry, l *alibilog.Leaf) error {
	logged, ok, err := o.claims.get(l.AlibiID)
	if err != nil {
		return err
	}
	switch l.Kind {
	case alibilog.KindBridge:
		if !ok || *l.Predecessor != logged {
			return refuse("bridge.parent")
		}
		if _, active, err := reg.Active(ctx, teeTDX, l.StatementSigner, time.Now()); err != nil {
			return err
		} else if !active {
			return refuse("bridge.signer")
		}
	default:
		if !ok || *l.Parent != logged {
			return refuse("card.parent")
		}
	}
	return nil
}

// claimOf is the key a leaf is claimed under: one purchase leaf and one bridge per purchase, one
// decision per card network authorization, one settlement per issuer transaction.
func claimOf(l *alibilog.Leaf) string {
	switch l.Kind {
	case alibilog.KindBridge:
		return "bridge-" + l.AlibiID
	case alibilog.KindCardAuthorization:
		return "card-" + l.AlibiID + "-" + hex.EncodeToString(l.Authorization.AuthorizationHash[:])
	case alibilog.KindCardSettlement:
		return "settlement-" + l.AlibiID + "-" + hex.EncodeToString(l.Settlement.TransactionHash[:])
	}
	return l.AlibiID
}

func measurementID(kind int, m [32]byte) string {
	prefix := map[int]string{teeTDX: "tdx", teeNitro: "nitro"}[kind]
	return fmt.Sprintf("%s:%s", prefix, hex.EncodeToString(m[:]))
}

// code is the stable code of a refusal, or "" for an internal error.
func code(err error) string {
	var ae *admitError
	if errors.As(err, &ae) {
		return ae.Code
	}
	var le *alibilog.LeafError
	if errors.As(err, &le) {
		return le.Code
	}
	return ""
}
