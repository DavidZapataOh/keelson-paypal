package main

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TEE kinds, as tee_signers.tee_kind stores them.
const (
	teeTDX   = 1
	teeNitro = 2
)

// registry reads the signers the API admitted and the mode it countersigned
// each purchase in. The log only reads.
type registry struct{ db *pgxpool.Pool }

// Active returns the measurement of the signer at address if it is registered
// for teeKind, not revoked, not expired and attested within the last two hours.
func (r registry) Active(ctx context.Context, teeKind int, address [20]byte) (string, bool, error) {
	var m string
	err := r.db.QueryRow(ctx, `select measurement from tee_signers
		where address = $1 and tee_kind = $2 and revoked_at is null and expires_at > now()
		and verified_at > now() - interval '2 hours'`, address[:], teeKind).Scan(&m)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	return m, err == nil, err
}

// PurchaseMode returns the countersign mode recorded for the purchase.
func (r registry) PurchaseMode(ctx context.Context, purchaseID string) (string, bool, error) {
	var m *string
	err := r.db.QueryRow(ctx, `select countersign_mode from purchases where id = $1`, purchaseID).Scan(&m)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && m == nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return *m, true, nil
}
