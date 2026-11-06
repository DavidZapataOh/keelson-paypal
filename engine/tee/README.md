# keelson-tee

The Keelson engine as it runs inside a TEE. It registers mandates and countersigns carts, and signs every decision, ALLOW or DENY, with a secp256k1 key that is generated in RAM at boot and bound into the TEE attestation through `report_data`.

Two legs run the same engine:

- **Leg A** (Intel TDX on Phala Cloud) holds the KMS root. It derives the credential issuer key, each user's holder key and the sealing key from it, issues the user credential and the open mandate, keeps the budget ledger, and produces the `Observation` of each countersign. It refuses any request that carries an observation.
- **Leg B** (AWS Nitro Enclave) has no root. It is configured with the issuer's public key, refuses to register mandates, and countersigns only over the `Observation` leg A produced.

## Register a mandate

`Engine::register_mandate` takes the mandate the user signed with their passkey and the salt of its commitment. It recomputes `C_m` and requires it to equal `zk.commitment`, computes the challenge `M`, and verifies the passkey assertion over `M` on the engine's configured origin and the RP ID `keelson.finance`. It then issues the user credential (when the request has none) and the open mandate, and returns the salt sealed to the user and `M`.

The first registration of a `sub` binds it to its passkey in a sealed user record. Later registrations for that `sub` must use the same passkey, or present a user credential issued for that `sub` and the new passkey; otherwise they fail with `auth.sub_bound`. Which `sub` the first registration belongs to is taken from the caller: binding `sub` to the user's PayPal login inside the TEE comes with the PayPal read. The record store must be one the caller cannot delete from, since a lost record lets the `sub` be bound again.

## Countersign a cart

`Engine::countersign`:

1. verifies the closed mandate against the issuer key, its key binding to the request id and the cart hash, and the user's passkey assertion over `M`;
2. requires the user credential's holder key to be the request user's holder key;
3. canonicalizes the cart against the PayPal purchase unit and evaluates it with Cedar;
4. signs the EIP-712 `Countersign`, and on leg A, on ALLOW, reserves the amount until the countersign expires.

A request id is answered once per mandate. Right after authentication it is bound to its cart, under the same lock as the reservations: the same request with the same cart gets the same countersign and reserves nothing more, and the same id with another cart fails with `replay` before anything is evaluated. A countersign that fails releases its claim and any reservation it took.

## What each leg checks

Both legs verify every signature in the closed mandate and the passkey assertion. Two checks run on leg A only, and leg B takes their result from leg A's `Observation`:

- **The user ↔ holder-key binding.** The user credential's `sub` is never presented, so the holder key is what ties a credential to a user. Leg A derives `user_key(sub)` from the root; leg B has no root and uses the holder key leg A observed.
- **The PayPal order read** and the budget left on the mandate.

## Budget

Leg A computes the budget left on a mandate as `max − captured − live reservations`. The captured amount comes only from the engine's own PayPal read (a `CapturedSource`); leg A refuses to countersign until it has one (`not_ready`). Reservations are keyed by `M`, which commits to the whole mandate, so mandates never share a budget. Reserving is the last step of a countersign, after signing, so a failed request never holds a reservation.

Reservations live only in RAM. An engine allows nothing for the first 900 seconds after boot, the lifetime of a countersign, so a reservation lost in a restart can never be spent twice.

## Errors

Refusals carry no signature and one of these stable codes: `auth.closed_*`, `auth.open_*`, `auth.webauthn_*`, `auth.sub_bound`, `clock_skew`, `no_root`, `not_ready`, `commitment_mismatch`, `replay`, `bad_request` and `signer`.

## Sealing

One sealing key covers every purpose. Each sealed blob is bound to a purpose label, the user it belongs to and the record id, and opens for nothing else.
