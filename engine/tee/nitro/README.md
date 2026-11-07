# Leg B on AWS Nitro Enclaves

The engine image runs in a Nitro Enclave on a `c6a.xlarge` parent in `us-west-2`. The enclave has no network. The parent forwards bytes to it over vsock and holds nothing the enclave depends on.

```
client --TLS--> Caddy :443 --> 127.0.0.1:8000 --socat--> vsock 16:5000 --> keelson-engine
```

- `keelson-vsock.service` is `socat` from `127.0.0.1:8000` to the enclave (CID 16, port 5000). Caddy terminates TLS for `tee-b.keelson.finance` and proxies to that port. Neither has a route, rewrite or body handling.
- The enclave image is the engine image with the command `--platform nitro --listen vsock:5000`, built on the parent by `nitro-cli build-enclave` from the image digest. Its PCR0–2 are recorded in `eif.json`.
- The enclave gets its configuration once, in `POST /v1/boot`: the chain, the bond vault and verifying contract, the image digest, the issuer's public key, the passkey origin, the SHA-256 of the bearer token and a recent Arbitrum Sepolia block. Until then every route answers `503 not_ready`; after it, `POST /v1/boot` answers `409 already_booted`. The parent cannot change what a running signer is configured with.
- Before it serves anything the enclave checks that the kernel's entropy source is `nsm-hwrng`, the Nitro Secure Module's generator, and exits otherwise. The signer key is generated afterwards, in RAM.
- Caddy is started only after the boot message was accepted, so `/v1/boot` is never reachable from the internet before the enclave is configured.

## Attestation

`GET /v1/attestation` returns

```json
{
  "tee": "nitro",
  "document": "<base64: the NSM attestation document, a COSE_Sign1>",
  "binding": {
    "chainId": "421614",
    "bondVault": "0x…",
    "teeKind": 2,
    "signer": "0x…",
    "policySetHash": "0x…",
    "engineBuildId": "0x…",
    "bootEpoch": "…",
    "issuerJwkThumbprint": "0x…"
  },
  "block": { "number": 0, "hash": "0x…" }
}
```

In the document, `user_data` is `report_data(binding, block.hash)`, `public_key` is the signer's uncompressed SEC1 key and `nonce` is the block hash. The enclave cannot read the chain, so the parent supplies the block; a verifier checks that `block.hash` is the hash of block `block.number` and that it is recent. `POST /v1/attestation/refresh` (bearer) with `{ "block": { "number", "hash" } }` attests the same signer over a newer block. A served document older than an hour is replaced by `503 attestation_stale` until it is refreshed.

## Scripts

They read `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION` from the environment, and `launch.sh` also `CLOUDFLARE_API_TOKEN`.

| Script                       |                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `launch.sh`                  | Creates the security group (inbound 80 and 443), the SSM-only instance role, the instance (`--enclave-options Enabled=true`, IMDSv2 required), an Elastic IP and the `tee-b` `A` record (DNS only, so Caddy gets its own certificate). There is no SSH. Run once.                                                  |
| `update.sh sha256:<digest>`  | Pulls the image by digest, builds the EIF on the parent, restarts the enclave, boots it and writes `eif.json`. Needs `KEELSON_TEE_TOKEN_SHA256` and `KEELSON_ISSUER_JWK`; `--hold` leaves the enclave unbooted.                                                                                                    |
| `start.sh`, `stop.sh`        | Start or stop the parent. A stopped parent kills its enclave, so `start.sh` runs `update.sh` and every start is a new signer.                                                                                                                                                                                      |
| `drift.sh start <leg A url>` | Starts a 24 h clock-drift job on the parent as a systemd unit (`keelson-clock-drift`): every 5 minutes it compares the engine clock in `/v1/health` of both legs with the parent's chrony-synced clock and logs one JSON line to `/var/log/keelson-clock-drift.jsonl`. `summary`, `log` and `stop` read or end it. |
| `check.sh`                   | Asserts one `RUNNING` enclave outside debug mode with the PCRs of `eif.json`, and that `https://tee-b.keelson.finance/v1/health` answers `tee: 2` (`TeeKind::Nitro`) for the same image digest.                                                                                                                    |

The parent also runs witness 3 of the Alibi log in its own container, outside the enclave; see [`services/witness`](../../../services/witness).

`parent/` holds what runs on the instance: `user-data.sh` (packages, pinned Caddy and Node, units), `allocator.yaml` (2 vCPUs, 1024 MiB), `Caddyfile`, the three units and `boot.ts`.

## Tests

`tests/nitro_live.rs` runs against the deployed enclave:

```sh
nitro/update.sh sha256:<digest> --hold
node nitro/parent/boot.ts <boot.json> --print > boot-request.json
KEELSON_LIVE=1 TEE_B_URL=https://tee-b.keelson.finance KEELSON_BOOT_REQUEST=boot-request.json \
  KEELSON_TEE_TOKEN=… cargo test -p keelson-tee --features tdx,nitro --test nitro_live -- --ignored --test-threads 1
```

The first test needs the unbooted enclave `--hold` leaves; the others run against any booted one. Enclaves in debug mode have all-zero PCRs and are never used for anything the tests assert on. The test environment is a real enclave on AWS and the Arbitrum Sepolia testnet.

The cross-leg tests also need `TEE_A_URL`, `PAYPAL_AUTHORIZATION_CREATED` and the same bearer token on both legs. `leg_b_signs_the_digest_leg_a_signed` takes a real countersign from leg A and replays it with A's observation to leg B. `a_restart_changes_the_signer_and_not_the_measurements` reruns `update.sh` for the digest in `eif.json`; it needs `update.sh`'s environment, with `KEELSON_ISSUER_JWK` taken from `TEE_A_URL/v1/health`.

`scripts/rtt.ts --leg b` measures the round trip of `GET /v1/health` from where it runs.
