# keelson-tee

The Keelson engine as it runs inside a TEE. It registers mandates and countersigns carts, and signs every decision, ALLOW or DENY, with a secp256k1 key that is generated in RAM at boot and bound into the TEE attestation through `report_data`.

Two legs run the same engine:

- **Leg A** (Intel TDX on Phala Cloud) holds the KMS root. It derives the credential issuer key, each user's holder key and the sealing key from it, issues the user credential and the open mandate, and keeps the budget ledger.
- **Leg B** (AWS Nitro Enclave) has no root. It is configured with the issuer's public key, refuses to register mandates, and countersigns over the `Observation` leg A sends with each request.

## Register a mandate

`Engine::register_mandate` takes the mandate the user signed with their passkey and the salt of its commitment. It recomputes `C_m` and requires it to equal `zk.commitment`, computes the challenge `M`, and verifies the passkey assertion over `M`. It then issues the user credential (when the request has none) and the open mandate, and returns the salt sealed to the user and `M`.

## Countersign a cart

`Engine::countersign`:

1. verifies the closed mandate against the issuer key, its key binding to the request id and the cart hash, and the user's passkey assertion over `M`;
2. requires the user credential's holder key to be the request user's holder key;
3. canonicalizes the cart against the PayPal purchase unit and evaluates it with Cedar;
4. signs the EIP-712 `Countersign`, and on ALLOW reserves the amount until the countersign expires.

## What each leg checks

Both legs verify every signature in the closed mandate and the passkey assertion. Two checks run on leg A only, and leg B takes their result from leg A's `Observation`:

- **The user ↔ holder-key binding.** The user credential's `sub` is never presented, so the holder key is what ties a credential to a user. Leg A derives `user_key(sub)` from the root; leg B has no root and uses the holder key leg A observed.
- **The PayPal order read** and the budget left on the mandate.

## Budget

Reservations live only in RAM. An engine allows nothing for the first 900 seconds after boot, the lifetime of a countersign, so a reservation lost in a restart can never be spent twice.

## Sealing

One sealing key covers every purpose. Each sealed blob is bound to a purpose label, the user it belongs to and the record id, and opens for nothing else.
