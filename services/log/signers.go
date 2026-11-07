package main

import (
	"context"
	"errors"
	"time"

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

// Active returns the measurement of the signer at address if it could sign for
// teeKind when the countersign was issued: registered by then, attested within
// the two hours before, not yet expired, and not revoked, unless it was only
// superseded by a newer signer of its leg after it signed. Any other revocation
// (a contradiction, for one) voids all its signatures.
func (r registry) Active(ctx context.Context, teeKind int, address [20]byte, issuedAt time.Time) (string, bool, error) {
	var m string
	err := r.db.QueryRow(ctx, `select measurement from tee_signers
		where address = $1 and tee_kind = $2
		and registered_at <= $3 and verified_at >= $3 - interval '2 hours' and expires_at > $3
		and (revoked_at is null or (revoked_reason = 'superseded' and revoked_at > $3))`,
		address[:], teeKind, issuedAt).Scan(&m)
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
