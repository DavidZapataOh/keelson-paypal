# keelson-tee

The Keelson engine as it runs inside a TEE. It registers mandates and countersigns carts, and signs every decision, ALLOW or DENY, with a secp256k1 key that is generated in RAM at boot and bound into the TEE attestation through `report_data`.

Two legs run the same engine:

- **Leg A** (Intel TDX on Phala Cloud) holds the KMS root. It derives the credential issuer key, each user's holder key and the sealing key from it, issues the user credential and the open mandate, keeps the budget ledger, and produces the `Observation` of each countersign. It refuses any request that carries an observation.
- **Leg B** (AWS Nitro Enclave) has no root. It is configured with the issuer's public key, refuses to register mandates, and countersigns only over the `Observation` leg A produced.

## Register a mandate

`Engine::register_mandate` takes the mandate the user signed with their passkey and the salt of its commitment. It recomputes `C_m` and requires it to equal `zk.commitment`, computes the challenge `M`, and verifies the passkey assertion over `M` on the engine's configured origin and the RP ID `keelson.finance`. It then issues the user credential (when the request has none) and the open mandate, and returns the salt sealed to the user and `M`.

The first registration of a `sub` binds it to its passkey in a sealed user record. Later registrations for that `sub` must use the same passkey, or present a user credential issued for that `sub` and the new passkey; otherwise they fail with `auth.sub_bound`. Which `sub` the first registration belongs to is taken from the caller. The record store must be one the caller cannot delete from, since a lost record lets the `sub` be bound again.

## Countersign a cart

`Engine::countersign`:

1. verifies the closed mandate against the issuer key, its key binding to the request id and the cart hash, and the user's passkey assertion over `M`;
2. requires the user credential's holder key to be the request user's holder key;
3. canonicalizes the cart against the PayPal purchase unit and evaluates it with Cedar;
4. signs the EIP-712 `Countersign`, and on leg A, on ALLOW, reserves the amount until the countersign expires.

A request id is answered once per mandate. Right after authentication it is bound to the digest of the whole request (closed mandate, cart, PayPal unit, evidence, evidence root and observation), in one record that also holds its reservation and its answer and expires with the countersign. The same input gets the same countersign and reserves nothing more; any other input under the id fails with `replay` before anything is evaluated. A countersign that fails removes the record and its reservation.

## What each leg checks

Both legs verify every signature in the closed mandate and the passkey assertion. Two checks run on leg A only, and leg B takes their result from leg A's `Observation`:

- **The user ↔ holder-key binding.** The user credential's `sub` is never presented, so the holder key is what ties a credential to a user. Leg A derives `user_key(sub)` from the root; leg B has no root and uses the holder key leg A observed.
- **The PayPal read** and the budget left on the mandate (see below).

## Budget

Leg A computes the budget left on a mandate as `max − captured − live reservations`. The captured amount comes only from the engine's own PayPal read (a `CapturedSource`); leg A refuses to countersign until it has one (`not_ready`). Reservations are keyed by `M`, which commits to the whole mandate, so mandates never share a budget. Reserving is the last step of a countersign, after signing, so a failed request never holds a reservation.

A countersign is valid through its `expiresAt` second, so its reservation is held until that second is over. A request id is accepted only while its ULID time is within the last 840 s and at most 60 s ahead, so an id can never be signed again once its record has expired. While warming up, a cart is allowed only if it costs nothing and the budget is not overspent; a zero total reserves nothing.

Reservations live only in RAM. An engine allows nothing for the first 900 seconds after boot, the lifetime of a countersign, so a reservation lost in a restart can never be spent twice.

## PayPal read

On leg A, `CountersignRequest.authorization_id` names the PayPal authorization that holds the mandate's funds. Before each countersign the engine reads it fresh, with its own OAuth 2.0 client credentials (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`; sandbox unless `PAYPAL_ENV=live`): `GET /v2/payments/authorizations/{id}` and then `GET /v2/checkout/orders/{id}` for the captures, 2 s per call and no retries. A failed read is `paypal` (502) and signs nothing.

The reading is the `PayPalObservation` leg B signs over. `captured_minor` is the sum of the order's captures of that authorization (below), and replaces the `CapturedSource` amount in the budget. The cart is denied (bit 31 of `failedFieldsMask`, the reason in the trace `errors`) when:

| Reason                 | When                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `paypal.status`        | the authorization is neither `CREATED` nor `PARTIALLY_CAPTURED`                     |
| `paypal.payee`         | the payee is not in the mandate's `payment.allowed_payees`                          |
| `paypal.currency`      | the authorization is not in the cart's currency                                     |
| `paypal.expired`       | the authorization's `expiration_time` has passed, whatever its status says          |
| `paypal.mandate`       | the `custom_id` is not `ks1.<env>m.<mid>.<digest>` for this mandate and environment |
| `paypal.inconsistent`  | `PARTIALLY_CAPTURED` with nothing captured, or more captured than authorized        |
| `paypal.hold_mismatch` | another authorization already holds this mandate                                    |
| `paypal.insufficient`  | the authorization's amount less what was captured is below the cart's total         |

Every capture of the authorization counts at its full amount unless it is `DECLINED` or `FAILED`: a refund does not restore the hold. A capture PayPal does not link to an authorization, or a negative amount, fails the read.

The authorization is the hold, one per mandate: leg A binds the first authorization it sees for a mandate in a sealed record (kept with the user records) and denies any other. The limit: the binding lives in that store, so a lost record lets a second authorization of the same mandate id be bound, and leg B cannot see it. The environment is Arbitrum Sepolia for `s` and Arbitrum One for `p`.

## Limits

Registering refuses a mandate whose `exp` has passed (`mandate_expired`) or whose `nbf` has not been reached (`mandate_not_yet_valid`). Every request is bounded before anything is parsed further: bodies at 256 KiB at the HTTP boundary, and in the engine `sub` at 128 bytes, tokens at 128 KiB, `payload_sd` at 128 KiB, 512 disclosures of at most 4 KiB, 64 cart lines, 16 evidence fields of 16 sources, and 256 bytes for any other string. Anything over a limit fails with `payload_too_large`.

## Errors

Refusals carry no signature and one of these stable codes: `auth.closed_*`, `auth.open_*`, `auth.webauthn_*`, `auth.sub_bound`, `clock_skew`, `no_root`, `not_ready`, `commitment_mismatch`, `replay`, `bad_request`, `payload_too_large`, `mandate_expired`, `mandate_not_yet_valid`, `paypal` and `signer`.

## HTTP

`keelson-engine --listen tcp:<addr>` serves `POST /v1/countersign`, `POST /v1/mandates/register` and `GET /v1/health` (`{ tee, signer, boot_epoch, oci_digest, version, now_ms, issuer }`, `now_ms` being the engine's clock and `issuer` being the credential issuer's public JWK). With `--platform tdx` it also serves `GET /v1/attestation` and `POST /v1/attestation/refresh` (see below). Every route except health and `GET /v1/attestation` needs `Authorization: Bearer <token>`; the engine holds only the token's SHA-256, from `KEELSON_TEE_TOKEN_SHA256`, and compares it in constant time. Refusals are `application/problem+json` (RFC 9457) with `type` `https://keelson.finance/problems/<code>` and the stable code, and never echo the request. Bodies are JSON with unknown fields rejected.

| Status | Codes                                                                            |
| ------ | -------------------------------------------------------------------------------- |
| 401    | `unauthorized`                                                                   |
| 403    | `auth.*`                                                                         |
| 409    | `replay`, `clock_skew`, `already_booted`                                         |
| 413    | `payload_too_large`                                                              |
| 422    | `bad_request`, `commitment_mismatch`, `mandate_expired`, `mandate_not_yet_valid` |
| 501    | `no_root`                                                                        |
| 503    | `not_ready`, `attestation_stale`                                                 |
| 500    | `signer`, `internal`                                                             |
| 502    | `attestation`, `paypal`                                                          |

The binary reads its configuration from `KEELSON_*` environment variables (see `src/main.rs`). Without `--platform` it holds no KMS root.

## Leg A on Intel TDX

Built with the cargo feature `tdx`, `keelson-engine --platform tdx --listen tcp:<addr>` runs as leg A in a [dstack](https://github.com/Dstack-TEE/dstack) CVM. It talks to the guest agent's v1 API (`dstack.guest.v1`, dstack 0.6 or later) on `/var/run/dstack.sock`:

1. `GetKey` with domain `keelson/root/v1` and algorithm `secp256k1` gives the 32-byte KMS root. It is the only key the engine asks the KMS for; the issuer, holder and sealing keys are derived from it.
2. The engine boots with that root and a fresh signer, and reads the latest block from Arbitrum Sepolia (`ARBITRUM_SEPOLIA_RPC_URL`, or the public RPC), checking the RPC's `eth_chainId` is the engine's chain.
3. `Attest` over `report_data(binding, block.hash)` gives the versioned attestation. The engine checks that the report data in it and in its TDX quote is the one it asked for.

`GET /v1/attestation` is public:

```json
{
  "tee": "tdx",
  "attestation": "<hex: the v1 Attest attestation, MessagePack, as dstack-verifier takes it>",
  "quote": "<hex: the TDX quote inside it>",
  "event_log": [
    {
      "imr": 3,
      "event_type": 134217729,
      "digest": "<hex>",
      "event": "compose-hash",
      "event_payload": "<hex>"
    }
  ],
  "binding": {
    "chainId": "421614",
    "bondVault": "0x…",
    "teeKind": 1,
    "signer": "0x…",
    "policySetHash": "0x…",
    "engineBuildId": "0x…",
    "bootEpoch": "…",
    "issuerJwkThumbprint": "0x…"
  },
  "block": { "number": 0, "hash": "0x…" },
  "app_id": "<hex>",
  "compose_hash": "<hex>",
  "dstack_version": "0.6.1"
}
```

A relying party checks that `dstack-verifier` accepts `attestation`, that its report data is `report_data(binding, block.hash)` and `binding.signer` is the signer it trusts, and that `block.hash` is the hash of block `block.number` on the chain and the block is recent. The engine attests the same signer over the latest block every 50 minutes, and `POST /v1/attestation/refresh` (bearer) does it on demand, failing with `attestation` when the agent or the RPC does not answer. A failed attempt keeps the attestation already served; once its block was read more than an hour ago, `GET /v1/attestation` answers `503 attestation_stale` until an attempt succeeds. So a served attestation always names a block less than an hour old.

`tests/tdx_simulator.rs` runs the boot against the dstack guest agent simulator, whose quote is a captured one with the report data written in, so it checks what the engine asks for and binds, not the quote. `tests/tdx_live.rs` checks a deployed CVM end to end, including `dstack-verifier`.

## Leg B on AWS Nitro Enclaves

Built with the cargo feature `nitro`, `keelson-engine --platform nitro --listen vsock:5000` runs as leg B inside an enclave that has no network and no environment. Until `POST /v1/boot` every route answers `503 not_ready`. The boot message carries the chain, the bond vault and verifying contract, the image digest, the issuer's public JWK, the passkey origin, the SHA-256 of the bearer token and a recent Arbitrum Sepolia block; it is accepted once, and any other answers `409 already_booted`. The engine refuses to start unless the kernel's entropy source is `nsm-hwrng`, then generates the signer and asks the Nitro Secure Module for an attestation document whose `user_data` is `report_data(binding, block.hash)`, `public_key` the signer's SEC1 key and `nonce` the block hash.

`GET /v1/attestation` is public and returns `{ tee: "nitro", document, binding, block }`, with `document` the COSE_Sign1 in base64. `POST /v1/attestation/refresh` (bearer) takes `{ block }` and attests the same signer over that newer block. The enclave cannot read the chain, so the caller supplies the block and a verifier checks it. A served document older than an hour answers `503 attestation_stale`. Leg B keeps no records. `nitro/README.md` describes the parent instance, the proxy and the scripts, and `tests/nitro_live.rs` checks a deployed enclave.

## Records

On `--platform tdx` the user records (each `sub`'s passkey binding and each mandate's hold) are kept by `FileRecords`, one sealed file per record, in `KEELSON_DATA_DIR` (`/data` by default). The image ships `/data` owned by the engine's user, and the compose file mounts a named volume there, which lives on the CVM's encrypted disk. A restart or redeploy of the same app keeps the records. A file that was altered or moved does not open under its `sub` or mandate, and the request that depends on it fails with `auth.sub_bound` or a `paypal.hold_mismatch` denial.

## Sealing

One sealing key covers every purpose. Each sealed blob is bound to a purpose label, the user it belongs to and the record id, and opens for nothing else.

## Image

`Containerfile` builds `keelson-engine` with the `tdx` and `nitro` features as a static musl binary with the StageX Rust pallet, network off, and ships it alone in a `scratch` image with the CA roots, running as user 65534. Every base image is pinned by digest. Build it from the repository root:

```sh
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct)" docker buildx build -f engine/tee/Containerfile . \
  --no-cache --platform linux/amd64 --build-arg BUILDKIT_MULTI_PLATFORM=1 \
  --provenance=false --sbom=false \
  --output type=oci,rewrite-timestamp=true,force-compression=true,dest=keelson-engine.tar
```

The `tee-image` workflow builds the image twice on separate runners from fresh checkouts and fails unless both digests are equal. On `main` it pushes that archive unchanged to `ghcr.io/davidzapataoh/keelson-engine` with a build provenance attestation. The image index digest is the `engine_build_id` bound into `report_data`; the engine receives it as `KEELSON_OCI_DIGEST`.

## Reproduce the measurements

`make measure` produces `out/measurements.json` from source: the OCI digest, the TDX measurement and the Nitro measurement of the deployment. It needs Linux, Docker with buildx, `curl`, `jq`, Node (`.node-version`) with `pnpm install` and `pnpm turbo run build --filter='@keelson/tee^...'` run first, and about 20 GB free.

```sh
make -C engine/tee measure [OCI_DIGEST=sha256:…] [INSTANCE_TYPE=tdx.small] [APP_ID=…] [OS_IMAGE=dstack-0.6.1]
```

1. **Image.** `OCI_DIGEST` defaults to the digest `phala/docker-compose.yml` pins. The `Containerfile` is built as above, with the `SOURCE_DATE_EPOCH` recorded in that image, and the command fails if the digest differs.
2. **TDX.** `dstack-mr` (built from the pinned dstack revision in a pinned Rust image) computes MRTD and RTMR0 to RTMR2 from the dstack OS image release (checked against its published SHA-256) and the CVM's size, `INSTANCE_TYPE`, with the host settings in `phala/vm-config.json`. The compose hash is the SHA-256 of `phala/app-compose.json` with `docker-compose.yml` inside it. `APP_ID` is fixed by the deployment. A different instance type, app id, OS image or compose file changes the id.
3. **Nitro.** `nitro-cli` 1.5.0 builds the EIF from the same image in a pinned Amazon Linux 2023 container, and its PCR0 to PCR2 are read with `describe-eif`.

The id is `tdx:` plus the SHA-256 of MRTD, RTMR0 to RTMR2, the app id, the compose hash and the OS image hash. RTMR3 is not in it: it extends the per-CVM instance id, so it is replayed from the event log and its events are checked instead. The Nitro id is `nitro:` plus the SHA-256 of PCR0 to PCR2.

`scripts/measure-check.ts <measurements.json>` compares the file with the attestations the two legs serve now (`TEE_A_URL`, `TEE_B_URL`) and exits 1 on any difference. The `tee-image` workflow runs `make measure` on two runners, requires byte-identical output, and checks it against the live legs.

## Benchmarks

`cargo bench -p keelson-tee` measures the demo countersign on both legs (closed-mandate and passkey verification through signing) and `register_mandate`, and fails if a p99 is over budget: 2 ms per countersign, 5 ms per registration.
