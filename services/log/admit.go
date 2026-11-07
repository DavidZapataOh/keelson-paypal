package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"

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
	l, err := alibilog.Parse(leaf)
	if err != nil {
		return err
	}
	if alibilog.Digest(c, o.chainID, o.verifyingContract) != l.CountersignDigest {
		return refuse("countersign.digest")
	}
	if l.Matches(c) != nil {
		return refuse("countersign.fields")
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
		m, ok, err := reg.Active(ctx, kinds[i], addr)
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
