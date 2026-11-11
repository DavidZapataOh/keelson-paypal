# keelson-tee

The Keelson engine as it runs inside a TEE. It registers mandates and countersigns carts, and signs every decision, ALLOW or DENY, with a secp256k1 key that is generated in RAM at boot and bound into the TEE attestation through `report_data`.

Two legs run the same engine:

- **Leg A** (Intel TDX on Phala Cloud) holds the KMS root. It derives the credential issuer key, each user's holder key and the sealing key from it, issues the user credential and the open mandate, keeps the budget ledger, and produces the `Observation` of each countersign. It refuses any request that carries an observation.
- **Leg B** (AWS Nitro Enclave) has no root. It is configured with the issuer's public key, refuses to register mandates, and countersigns only over the `Observation` leg A produced. It refuses with `clock_skew` an observation whose `now_ms` is more than 2 s ahead of its own clock or more than 60 s behind it; leg A answers a retried request id with the observation of the first attempt, so an older one is expected.

## Register a mandate

`Engine::register_mandate` takes the mandate the user signed with their passkey and the salt of its commitment. It recomputes `C_m` and requires it to equal `zk.commitment`, computes the challenge `M`, and verifies the passkey assertion over `M` on the engine's configured origin and the RP ID `keelson.finance`. It then issues the user credential (when the request has none) and the open mandate, and returns the salt sealed to the user and `M`.

A user may sign with any of their passkeys. Which passkeys belong to a `sub` is the caller's to say, as WebAuthn leaves it to the relying party: the API registers a passkey to a user only after a fresh sign-in with PayPal or with one of their passkeys, and sends leg A a mandate only when its `user.cred` is one of them. Leg A verifies the assertion against that credential and issues a user credential per passkey, all with the `sub`'s one holder key. A registration that presents a user credential must be for the same `sub`, holder key and passkey, or it fails with `auth.open_user_credential`.

## Countersign a cart

`Engine::countersign`:

1. verifies the closed mandate against the issuer key, its key binding to the request id and the cart hash, and the user's passkey assertion over `M`;
2. requires the user credential's holder key to be the request user's holder key;
3. canonicalizes the cart against the PayPal purchase unit and evaluates it with Cedar;
4. signs the EIP-712 `Countersign`, and on leg A, on ALLOW, reserves the amount until the countersign expires.

A request id is answered once per mandate. Right after authentication it is bound to the digest of the whole request (closed mandate, cart, PayPal unit, evidence, evidence root and observation), in one record that also holds its reservation and its answer and expires with the countersign. The same input gets the same countersign and reserves nothing more; any other input under the id fails with `replay` before anything is evaluated. A countersign that fails removes the record and its reservation.

## Prove C1

On leg A, an ALLOW whose request carries the mandate's `sealed_salt` (as registration returned it) also gets a C1 `mandate_predicate` proof (`circuits/c1`): that the mandate `C_m` commits to allows the cart's amount, currency, category and merchant at `issuedAt`, without revealing the mandate. Leg A opens the salt (sealed to the user and `M`), rebuilds the commitment's opening from the mandate, solves the circuit's witness in process with the ACVM, and proves it with `bb` 5.3.0 (the binary `@aztec/bb.js` 5.3.0 ships) over its msgpack pipe: UltraHonk with the keccak transcript and ZK, what the Solidity verifier and bb.js check, and again from the same witness with the Poseidon2 transcript (`noir-recursive`), what a Noir circuit verifies: the API composes that proof with the mandate's C3 (`circuits/c1c3`). The public inputs are the countersign's `mandateCommitment`, `amount`, `currency`, `category`, `merchantId`, `issuedAt`, `cartHash` reduced modulo the BN254 scalar field, and `agentId`. Leg B has no root, cannot open the salt and proves nothing.

Leg A answers the countersign first and proves right after, off the request's path; `GET /v1/c1/{request_id}` (bearer) serves the proof as `{ proof, public_inputs, recursive_proof }`, waiting up to 8 s for one still being made (`503 proof_pending` after that), and answers `404 no_proof` for a DENY, a request without the salt, a proof that could not be made or a request it does not hold. The latest 4,096 proofs are kept in memory, and a restart forgets them. A proof that cannot be made (a cart of several categories, a salt that does not open) is left out and the countersign stands on its signatures; a `bb` call that fails or takes over 5 s abandons that process, and the next proof starts a new one. The image ships `bb` with the glibc loader and `libc.so.6` it links, and the first 2^13 + 1 points of the Aztec Ignition CRS in `/crs` (`zk/bn254_g1.dat`), so proving never reaches the network. `circuits/c1/build.sh` writes the program and both keys in `zk/`, and CI checks they are what the circuit compiles to.

## Sign a checkpoint

`Engine::sign_checkpoint` signs the EIP-712 `Checkpoint(bytes32 origin, uint64 treeSize, bytes32 rootHash)` that `CheckpointAnchor` accepts, for a c2sp.org/tlog-checkpoint signed note of one of the logs in `src/checkpoint.rs` (keys copied from `services/log/policy`):

1. the body is exactly the origin, the decimal size and the canonical base64 root, with no extension lines;
2. the origin's Ed25519 log key signed it (c2sp.org/signed-note; signatures of unknown keys, such as the log's ML-DSA-44 one, are ignored);
3. for the Alibi origins, at least 2 of the 3 witnesses cosigned it (c2sp.org/tlog-cosignature `cosignature/v1`, each witness counted once, timestamps at most 10 minutes ahead); the conformance origin needs the log key only, so drills can be anchored;
4. the origin anchors on the request's chain (`chain_id`, the engine's own chain when absent): the sandbox and conformance origins on Arbitrum Sepolia, the live origin on Arbitrum One.

`origin` is `keccak256` of the origin string, and the domain is the engine's (`verifyingContract` = the `VerdictVerifier`). Because both legs sign only witnessed checkpoints, the log key alone cannot get a checkpoint anchored.

## Sign a verdict

`Engine::sign_verdict` attributes a PayPal dispute and signs the EIP-712 `Verdict` that `KeelsonBondVault.slash` and `KeelsonReserve.payWarranty` check. The request carries the dispute's facts (`keelson_policy::Facts`: the PayPal reason and the booleans the host derived from the Alibi, PayPal and the chain) and the settlement terms (`dispute id`, `coverageId`, `agentId`, `payee`, `amount`, a failed field of each color as its `failedFieldsMask` bit, `evidenceHash`, `checkpointRoot`, `issuedAt`, `deadline`). The leg runs `keelson_policy::verdict`, the attribution policy sets in Cedar, so the rule, the liable party and the `fieldId` (the failed field of the rule's color for R60–R62, none otherwise) are the engine's, never the caller's; terms the rule refuses (a field rule with no failed field of its color, a deadline not after `issuedAt`, an amount beyond `uint96`) fail with `bad_request`. Both legs answer the same digest for the same request.

## Notarize a TLS session

Leg A is the TLSNotary notary for public product endpoints. `GET /v1/notary` (bearer) with `Connection: upgrade` and `Upgrade: keelson-notary` answers `101` and runs one TLSNotary session (`tlsn` 0.1.0-alpha.15, through `engine/tlsn`) over the connection: MPC-TLS, or Proxy-TLS, in which the leg dials the server itself, at public addresses only. It accepts a session only when the prover revealed the server name, the whole request, a `GET` with no cookies or credentials (only `Host`, `Accept`, `Accept-Encoding: identity`, `Connection` and `User-Agent`), and the status line and headers of a `200` response, and committed with SHA-256 to one range of the body, at most 1 KiB sent and 16 KiB received. It then signs the EIP-712 `WebFact` with its attested signer and writes it on the same connection as one JSON object before closing it:

```json
{
  "web_fact": {
    "hostHash": "0x…",
    "urlPathHash": "0x…",
    "tCapture": 1794200000,
    "rangeCommitment": "0x…",
    "attId": "0x…"
  },
  "chain_id": 421614,
  "digest": "0x…",
  "signature": "0x…",
  "signer": "0x…"
}
```

`hostHash` and `urlPathHash` are `keccak256` of the server name and of the request target, `tCapture` the leg's clock when the session ended, `rangeCommitment` the prover's `SHA-256(range ‖ blinder)` (tlsn's plaintext hash), and `attId` the signer binding its attestation covers (the first 32 bytes of `report_data`), so the key that signs a `WebFact` is the one registered in the `VerdictVerifier`. A refused session is answered with `{ "error": "<code>" }`. One session runs at a time (`503 busy` otherwise) and each is cut at 30 s.

## What each leg checks

Both legs verify every signature in the closed mandate and the passkey assertion. Two checks run on leg A only, and leg B takes their result from leg A's `Observation`:

- **The user ↔ holder-key binding.** The user credential's `sub` is never presented, so the holder key is what ties a credential to a user. Leg A derives `user_key(sub)` from the root; leg B has no root and uses the holder key leg A observed.
- **The PayPal read** and the budget left on the mandate (see below).

## Security

**What only leg A observes.** The PayPal read and the budget left on the mandate, and the binding of a user to their passkey and of a mandate to its authorization. Leg B signs over leg A's observation, so a DENY from leg A's checks is a DENY on both legs, and leg B contributes the independent verification of every signature, the Cedar evaluation and a second vendor's attestation.

**What 1-of-2 (degraded) means.** When leg B is unreachable or its signer is not admitted, the API still countersigns with leg A alone and says so: `mode: "degraded"` in the body and `Keelson-Countersign-Mode: degraded` in the header, and `/status` reports `teeB: "down"`. In that mode a purchase rests on one TEE vendor. An integrator that requires two should refuse a `degraded` countersign.

**Why both vendors must agree.** TDX attestation can be forged by an attacker with physical access to the host (TEE.fail, 2025), and Nitro attestation is only as strong as AWS. A forged quote on one leg cannot produce a valid countersign by itself, because the other leg's signer is a different key under a different vendor's root of trust.

**Key handling.**

- The countersign key is generated in RAM at boot and never leaves the process. The KMS root (leg A) and the keys derived from it are held only while a request needs them. `Signer`, `Root` and `Engine` implement none of `Debug`, `Display`, `Serialize`, `Clone` or `Copy`, which `tests/key_material.rs` checks at compile time, and `Signer` and `Root` overwrite their key on drop, which their unit tests read back through a raw pointer. The keys derived from the root are `p256` `SigningKey`s, which zeroize on drop and whose `Debug` prints no key material; they live for one request.
- HKDF over the root wipes its pseudorandom key as soon as the expand state exists, and the HMAC states it keeps are SHA-256 cores built with `sha2`'s `zeroize` feature, which wipe themselves on drop. The intermediate blocks `hkdf` and `hmac` keep on the stack while they run are not wiped.
- Release builds abort on panic, and the process disables core dumps and `ptrace` of its memory (`PR_SET_DUMPABLE` 0) before it reads any secret. A panic on leg A restarts its container with a new signer and the 900-second warm-up; on leg B the engine stops serving until `nitro/update.sh` boots the enclave again.
- The HTTP layer logs no request or response bodies. Errors carry a stable code and never echo input.
- PayPal credentials and the bearer token's hash reach the CVM only as encrypted environment variables. `phala/docker-compose.yml` holds variable names, no values. Leg B's boot message carries the token's hash and public configuration only; the enclave has no network and no environment.
- Leg A and leg B run the same binary. The enclave never builds a KMS root or a PayPal client, since `--platform nitro` constructs neither. The image carries no proof tooling: `keelson-policy` is built without its `prove` feature, so neither `cedar-policy-symcc` nor cvc5 is linked.

**Accepted risks.**

- Both legs accept the same bearer token. Its holder can call the authenticated routes of either leg (register a mandate on leg A, countersign, refresh an attestation); it cannot sign anything a leg would not, since no route takes a key and every route verifies the mandate, the passkey and the cart itself. The token lives only in the API's environment and CI secrets, the legs store its SHA-256, and it is rotated as described below. Separate tokens per leg are not implemented.
- The CVM's host can wipe or roll back the whole encrypted data volume, not a single record. A wiped store lets a `sub` be bound again and a mandate be bound to a second authorization.
- When the canonicalizer refuses a cart, the trace records the refusal, and re-running `evaluate_context` over the same input does not reproduce that trace byte for byte.

## Budget

Leg A computes the budget left on a mandate as `max − captured − live reservations`. The captured amount comes only from the engine's own PayPal read (a `CapturedSource`); leg A refuses to countersign until it has one (`not_ready`). A capture whose `invoice_id` (`KS1-<request id>-…`) names a request is already in the captured amount, so that request's reservation counts only for what it reserved beyond its captures; a purchase is never counted twice, and one captured for less than it reserved still holds the rest. Reservations are keyed by `M`, which commits to the whole mandate, so mandates never share a budget. Reserving is the last step of a countersign, after signing, so a failed request never holds a reservation.

A countersign is valid through its `expiresAt` second, so its reservation is held until that second is over. A request id is accepted only while its ULID time is within the last 840 s and at most 60 s ahead, so an id can never be signed again once its record has expired. While warming up, a cart is allowed only if it costs nothing and the budget is not overspent; a zero total reserves nothing.

Each leg holds at most 4,096 live requests, with their answers, across all mandates; a new request beyond that is refused with `busy` until some expire, which bounds the ledger at a few tens of MiB whatever the request rate. Expired requests are dropped on every countersign.

Reservations live only in RAM. An engine allows nothing for the first 900 seconds after boot, the lifetime of a countersign, so a reservation lost in a restart can never be spent twice.

## PayPal read

On leg A, `CountersignRequest.authorization_id` names the PayPal authorization that holds the mandate's funds. Before each countersign the engine reads it fresh, with its own OAuth 2.0 client credentials (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`; sandbox unless `PAYPAL_ENV=live`): `GET /v2/payments/authorizations/{id}` and then `GET /v2/checkout/orders/{id}` for the captures, 2 s per call and no retries. A failed read is `paypal` (502) and signs nothing.

The reading is the `PayPalObservation` leg B signs over. `captured_minor` is the sum of the order's captures of that authorization (below), and replaces the `CapturedSource` amount in the budget. The cart is denied (bit 31 of `failedFieldsMask`, the reason in the trace `errors`) when:

| Reason                 | When                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paypal.status`        | the authorization is neither `CREATED` nor `PARTIALLY_CAPTURED`                                                                                      |
| `paypal.payee`         | the payee is not in the mandate's `payment.allowed_payees`                                                                                           |
| `paypal.currency`      | the authorization is not in the cart's currency                                                                                                      |
| `paypal.expired`       | the authorization's `expiration_time` has passed, whatever its status says                                                                           |
| `paypal.mandate`       | the `custom_id` is neither `ks1.<env>m.<mid>.<digest>` for this mandate nor `ks1.<env>a.<request id>.<digest>` for this request, in this environment |
| `paypal.inconsistent`  | `PARTIALLY_CAPTURED` with nothing captured, or more captured than authorized                                                                         |
| `paypal.hold_mismatch` | another PayPal order already holds this mandate                                                                                                      |
| `paypal.insufficient`  | the authorization's amount less what was captured is below the cart's total                                                                          |

Every capture of the authorization counts at its full amount unless it is `DECLINED` or `FAILED`: a refund does not restore the hold. A capture PayPal does not link to an authorization, or a negative amount, fails the read.

A mandate hold (`m`) is one PayPal order per mandate: leg A binds the mandate to the order of the first mandate hold it sees (`supplementary_data.related_ids.order_id`), in a sealed record kept with the user records, and denies an authorization of any other order. A reauthorization gets a new authorization id on the same order, so it still holds the mandate. Records written by earlier images bound the authorization id under another key and are not read: a mandate held before the upgrade is held again. A per-purchase hold (`a`) names the countersign's request id instead and is not bound, since the ledger answers a request id once. The limit: the binding lives in that store, so a lost record lets a second order of the same mandate id be bound, and leg B cannot see it. The environment is Arbitrum Sepolia for `s` and Arbitrum One for `p`.

## Limits

Registering refuses a mandate whose `exp` has passed (`mandate_expired`) or whose `nbf` has not been reached (`mandate_not_yet_valid`). Every request is bounded before anything is parsed further: bodies at 256 KiB at the HTTP boundary, and in the engine `sub` at 128 bytes, tokens at 128 KiB, `payload_sd` at 128 KiB, 512 disclosures of at most 4 KiB, 64 cart lines, 16 evidence fields of 16 sources, and 256 bytes for any other string. Anything over a limit fails with `payload_too_large`.

## Errors

Refusals carry no signature and one of these stable codes: `auth.closed_*`, `auth.open_*`, `auth.webauthn_*`, `clock_skew`, `no_root`, `not_ready`, `commitment_mismatch`, `replay`, `busy`, `bad_request`, `payload_too_large`, `mandate_expired`, `mandate_not_yet_valid`, `paypal`, `signer`, and for checkpoints `checkpoint_format`, `checkpoint_origin`, `checkpoint_chain`, `checkpoint_log_signature` and `checkpoint_quorum`.

## HTTP

`keelson-engine --listen tcp:<addr>` serves `POST /v1/countersign`, `GET /v1/c1/{request_id}` (see Prove C1), `GET /v1/notary` on leg A (see Notarize a TLS session), `POST /v1/mandates/register`, `POST /v1/verdict` (`{ facts, input, chain_id? }`, answered with `{ verdict, chain_id, digest, signature, signer, tee }`), `POST /v1/checkpoint` (`{ signed_note, chain_id? }`, at most 16 KiB, answered with `{ origin, tree_size, root_hash, chain_id, digest, signature, signer }`) and `GET /v1/health` (`{ tee, signer, boot_epoch, oci_digest, version, now_ms, issuer, rss_kib }`, `now_ms` being the engine's clock, `issuer` the credential issuer's public JWK and `rss_kib` the process's resident memory on Linux). With `--platform tdx` it also serves `GET /v1/attestation` and `POST /v1/attestation/refresh` (see below). Every route except health and `GET /v1/attestation` needs `Authorization: Bearer <token>`; the engine holds only the token's SHA-256, from `KEELSON_TEE_TOKEN_SHA256`, and compares it in constant time. Refusals are `application/problem+json` (RFC 9457) with `type` `https://keelson.finance/problems/<code>` and the stable code, and never echo the request. Bodies are JSON with unknown fields rejected.

| Status | Codes                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------ |
| 401    | `unauthorized`                                                                                   |
| 403    | `auth.*`                                                                                         |
| 409    | `replay`, `clock_skew`, `already_booted`                                                         |
| 413    | `payload_too_large`                                                                              |
| 422    | `bad_request`, `commitment_mismatch`, `mandate_expired`, `mandate_not_yet_valid`, `checkpoint_*` |
| 501    | `no_root`                                                                                        |
| 503    | `not_ready`, `busy`, `attestation_stale`                                                         |
| 500    | `signer`, `internal`                                                                             |
| 502    | `attestation`, `paypal`                                                                          |

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

A relying party checks that `dstack-verifier` accepts `attestation`, that its report data is `report_data(binding, block.hash)` and `binding.signer` is the signer it trusts, and that `block.hash` is the hash of block `block.number` on the chain and the block is recent. The engine attests the same signer over the latest block every 50 minutes, and `POST /v1/attestation/refresh` (bearer) does it on demand (`?chainId=42161` attests for Arbitrum One over its latest block, from `ARBITRUM_ONE_RPC_URL` or the public RPC, and returns that attestation without serving it), failing with `attestation` when the agent or the RPC does not answer. A failed attempt keeps the attestation already served; once its block was read more than an hour ago, `GET /v1/attestation` answers `503 attestation_stale` until an attempt succeeds. So a served attestation always names a block less than an hour old.

`tests/tdx_simulator.rs` runs the boot against the dstack guest agent simulator, whose quote is a captured one with the report data written in, so it checks what the engine asks for and binds, not the quote. `tests/tdx_live.rs` checks a deployed CVM end to end, including `dstack-verifier`.

## Leg B on AWS Nitro Enclaves

Built with the cargo feature `nitro`, `keelson-engine --platform nitro --listen vsock:5000` runs as leg B inside an enclave that has no network and no environment. Until `POST /v1/boot` every route answers `503 not_ready`. The boot message carries the chain, the bond vault and verifying contract, the image digest, the issuer's public JWK, the passkey origin, the SHA-256 of the bearer token and a recent Arbitrum Sepolia block; it is accepted once, and any other answers `409 already_booted`. The engine refuses to start unless the kernel's entropy source is `nsm-hwrng`, then generates the signer and asks the Nitro Secure Module for an attestation document whose `user_data` is `report_data(binding, block.hash)`, `public_key` the signer's SEC1 key and `nonce` the block hash.

`GET /v1/attestation` is public and returns `{ tee: "nitro", document, binding, block }`, with `document` the COSE_Sign1 in base64. `POST /v1/attestation/refresh` (bearer) takes `{ block }` and attests the same signer over that newer block; with `{ block, chain_id }` naming another supported chain it attests for that chain over that chain's block and returns the document without serving it. The enclave cannot read the chain, so the caller supplies the block and a verifier checks it. A served document older than an hour answers `503 attestation_stale`. Leg B keeps no records. `nitro/README.md` describes the parent instance, the proxy and the scripts, and `tests/nitro_live.rs` checks a deployed enclave.

## Records

On `--platform tdx` the user records (the PayPal order holding each mandate) are kept by `FileRecords`, one sealed file per record, in `KEELSON_DATA_DIR` (`/data` by default). The image ships `/data` owned by the engine's user, and the compose file mounts a named volume there, which lives on the CVM's encrypted disk. A restart or redeploy of the same app keeps the records. A file that was altered or moved does not open under its mandate, and the request that depends on it fails with a `paypal.hold_mismatch` denial.

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

## Environments

| Part                | Where                                                                       |
| ------------------- | --------------------------------------------------------------------------- |
| Leg A               | Phala Cloud, Intel TDX, `tdx.small` (1 vCPU, 2 GB), dstack 0.6.1, US-West-1 |
| Leg B               | AWS EC2 `c6a.xlarge` in `us-west-2`, Nitro Enclave with 2 vCPUs and 1 GiB   |
| Payments            | PayPal sandbox                                                              |
| Chain               | Arbitrum Sepolia                                                            |
| API and its callers | Render, Oregon                                                              |

Nothing here is simulated: the quotes are real TDX and Nitro attestations, and PayPal and the chain are the providers' own test environments.

## Operations

**Who holds which secret.**

| Secret                      | Held by                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| KMS root and signer keys    | Each leg's process only. Leg A's root comes from the dstack KMS; no key is ever exported |
| Bearer token                | The API's environment and the repository's CI secrets. The legs hold its SHA-256 only    |
| PayPal client id and secret | The API's environment, the CI secrets and leg A's encrypted environment                  |
| Phala Cloud API key         | The CI secrets and the operator                                                          |
| AWS access keys             | The operator only. The parent instance has an SSM-only role and no SSH                   |

**One signer, several chains.** A leg's signer serves every chain `keelson_core::domain` accepts (Arbitrum Sepolia and Arbitrum One). A countersign request may name its chain in `chain_id` (the engine's own chain when absent): the countersign is signed under that chain's EIP-712 domain, whose `chainId` makes it worthless on any other chain, and leg A refuses a chain whose PayPal environment is not the one it reads (Arbitrum One reads the live API, every other chain the sandbox). Each chain's attestation binds that chain's id and a recent block of that chain, so a signer is registered on each chain's `VerdictVerifier` separately, and each chain's governance decides which measurements it allows. A request id is answered once whatever the mandate or chain, and stays bound until it could no longer be accepted, so the same signer never signs two different countersigns under one id.

**Attestation refresh.** Each leg's attestation binds its signer to a recent Arbitrum Sepolia block, and a leg answers `503 attestation_stale` once that block is an hour old. The API refreshes both legs when it starts and every 50 minutes, verifies what they return, and admits a signer only while its last verification is under two hours old. Leg A also refreshes itself on the same timer. Leg B cannot read the chain, so the caller sends the block. By hand:

```sh
curl -X POST -H "authorization: Bearer $KEELSON_TEE_TOKEN" "$TEE_A_URL/v1/attestation/refresh"
curl -X POST -H "authorization: Bearer $KEELSON_TEE_TOKEN" -H 'content-type: application/json' \
  -d '{"block":{"number":<n>,"hash":"0x…"}}' "$TEE_B_URL/v1/attestation/refresh"
```

**Degraded mode.** With leg B down, or its signer not admitted, the API countersigns with leg A alone: `mode: "degraded"` in the body, `Keelson-Countersign-Mode: degraded` in the header, and `GET /status` answers `status: "degraded"` with `teeB: "down"` while leg B does not answer its health check. Every purchase then rests on one TEE vendor, so degraded mode is restored as soon as it is seen:

1. If the parent instance is stopped, `nitro/start.sh` starts it, rebuilds and boots the enclave for the digest in `nitro/eif.json` (about two minutes), and `nitro/check.sh` asserts one running enclave with the recorded PCRs. If the parent runs but leg B does not answer, `nitro/update.sh sha256:<digest>` with the same digest restarts and boots the enclave.
2. The new enclave has a new signer. The first countersign that meets it makes the API verify and admit it in the background, and the 50-minute refresh does too.
3. `GET /status` shows `teeB: "up"`, and countersigns return `mode: "2of2"`.

A stopped parent is the only state in which the second vendor is missing for more than a request, so it is left running.

**Restart a leg.** Leg A: `phala cvms restart --cvm-id <app id>`; its signer changes, its sealed records stay, and it allows nothing for 900 seconds. Leg B: `nitro/update.sh sha256:<digest>` with the digest in `nitro/eif.json`, which needs `KEELSON_TEE_TOKEN_SHA256` and `KEELSON_ISSUER_JWK` (the `issuer` in leg A's `/v1/health`).

**Rotate the bearer token.** Generate a token, set it as `KEELSON_TEE_TOKEN` in the API's environment and the CI secrets, and its SHA-256 as `KEELSON_TEE_TOKEN_SHA256` in the CI secrets. Run `tee-deploy` with the deployed digest (an update replaces leg A's encrypted environment and restarts the engine) and `nitro/update.sh` with the same digest, since the enclave takes the hash only in its boot message. Both legs restart, so countersigns wait for leg A's warm-up.

**Redeploy a new image.** Countersigning never stops if the chain and the API trust the new build before any leg runs it:

1. `tee-image` builds the image twice and publishes its digest from `main`.
2. On a branch, pin that digest where the legs read it (`phala/docker-compose.yml`, the compose it renders into `phala/app-compose.json`, and `nitro/eif.json`), and run `tee-image` on the branch (`workflow_dispatch`): its `measure` jobs compute both legs' measurements from source, before any deploy. Commit its `measurements` artifact as `measurements.json` and move the previous file into `measurements-rotation.json`, so the API admits the signers of both builds; add the new build to `TEE_BUILDS` in `packages/alibi/src/verify/trust.ts` and keep the old ones, so earlier Alibis keep verifying.
3. Allow both measurement ids on the `VerdictVerifier`: one timelock batch that has the AccessManager schedule `setAllowedMeasurement(id, true)` for each, and a second batch, scheduled in the same minute, that executes them once the `SIGNERS_ROLE` delay has passed (timelock 5 min, then the signers delay, on the testnets about 20 min in all).
4. Merge and deploy the API, which now admits both builds.
5. Run `tee-deploy` with the digest and `nitro/update.sh sha256:<digest>`. Commit the `deployment` artifact's files and the new `nitro/eif.json` if they differ from step 2, and check that `measure-live` passes. The API admits each new signer when it first meets it, and its refresh registers the signer on chain with `KEELSON_REGISTRAR_KEY`.
6. Once nothing runs the old build, empty `measurements-rotation.json` and disallow the old measurements from the Guardian Safe.

`make measure` fails on any change to the engine until step 2 is committed, by design: the source no longer builds the deployed digest.

**Cost.** Both legs run around the clock. Rates read on 2026-11-06:

| Item              | Per hour   | Per day   | To 2026-12-15 (936 h) |
| ----------------- | ---------- | --------- | --------------------- |
| Phala `tdx.small` | $0.0608    | $1.46     | $57                   |
| AWS `c6a.xlarge`  | $0.153     | $3.67     | $143                  |
| AWS public IPv4   | $0.005     | $0.12     | $5                    |
| AWS 30 GiB `gp3`  | $0.0033    | $0.08     | $3                    |
| **Both legs**     | **$0.222** | **$5.33** | **$208**              |

Stopping the parent outside working hours saves $3.67 a day and leaves every purchase 1-of-2 while it is stopped. A stopped CVM still bills its disk. The billing resources are one CVM, one EC2 instance, one Elastic IP and one EBS volume; anything else, on the Phala account or in any AWS region (instances, volumes, addresses, snapshots, AMIs), is an orphan and is deleted. To list them:

```sh
npx phala@1.2.1 cvms list
for r in $(aws ec2 describe-regions --query 'Regions[].RegionName' --output text); do
  aws ec2 describe-instances --region "$r" --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output text
  aws ec2 describe-volumes --region "$r" --query 'Volumes[].[VolumeId,State]' --output text
  aws ec2 describe-addresses --region "$r" --query 'Addresses[].[PublicIp,InstanceId]' --output text
  aws ec2 describe-snapshots --region "$r" --owner-ids self --query 'Snapshots[].SnapshotId' --output text
done
```

## Benchmarks

`cargo bench -p keelson-tee` measures the demo countersign on both legs (closed-mandate and passkey verification through signing) and `register_mandate`, and fails if a p99 is over budget: 2 ms per countersign, 5 ms per registration. `cargo bench -p keelson-tee --bench checkpoint` measures `sign_checkpoint` over a witnessed sandbox checkpoint: p50 98 µs, p99 116 µs on an Apple M-series host (budget 1 ms).

`services/api/bench/countersign.bench.ts` measures the live legs from where the API runs. Measured on 2026-11-07 from a Render one-off job of the API service (Oregon, AMD EPYC 7R13), against the legs above and a PayPal sandbox authorization, with sequential requests:

| Path                                                                          | p50    | p95    | Budget   |
| ----------------------------------------------------------------------------- | ------ | ------ | -------- |
| Leg A round trip, `/v1/health`                                                | 24 ms  | 25 ms  | < 150 ms |
| Leg B round trip, `/v1/health`                                                | 2 ms   | 3 ms   | < 150 ms |
| Leg B countersign                                                             | 6 ms   | 7 ms   |          |
| Both legs, leg A's PayPal read excluded                                       |        | 31 ms  | < 200 ms |
| Leg A countersign, with its PayPal read                                       | 364 ms | 422 ms |          |
| `POST /v1/countersign` in the API process, through both legs and the database | 393 ms | 452 ms |          |
| First countersign with leg B unreachable (`degraded`)                         | 408 ms | 435 ms | < 1 s    |

Leg A always reads PayPal on a countersign, so its own share is taken from its health round trip; the engine's work inside a countersign is under 2 ms. The PayPal sandbox read is most of every countersign.
