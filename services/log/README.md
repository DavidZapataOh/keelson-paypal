# Alibi log

A [Tessera](https://github.com/transparency-dev/tessera) personality that appends Alibi leaves to a
[c2sp.org/tlog-tiles](https://c2sp.org/tlog-tiles) log. It admits a leaf only when the two TEE legs
(or, while the Nitro leg is down, the TDX leg alone, marked `"mode":"degraded"` in the leaf)
countersigned the purchase it describes.

## Origins

| Origin                                  | Chain                     | Verifier keys                                                                                                                |
| --------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `log.keelson.finance/alibi/2026-1`      | Arbitrum Sepolia (421614) | [`alibi-2026-1.vkey`](keys/alibi-2026-1.vkey), [`alibi-2026-1.mldsa.vkey`](keys/alibi-2026-1.mldsa.vkey)                     |
| `log.keelson.finance/alibi-live/2026-1` | Arbitrum One (42161)      | [`alibi-live-2026-1.vkey`](keys/alibi-live-2026-1.vkey), [`alibi-live-2026-1.mldsa.vkey`](keys/alibi-live-2026-1.mldsa.vkey) |

Each origin is served at `https://<origin>/`: `checkpoint`, `tile/<L>/<N>[.p/<W>]` and
`tile/entries/<N>[.p/<W>]`. Every checkpoint ([c2sp.org/tlog-checkpoint](https://c2sp.org/tlog-checkpoint))
carries two log signatures: Ed25519 (`0x01`) and ML-DSA-44 (`0x06`, [c2sp.org/tlog-cosignature](https://c2sp.org/tlog-cosignature)).
A new checkpoint is published every second while the log grows, and every minute otherwise.

## Leaf

```
leaf = "keelson.finance/alibi/v1\n" || JCS(object)
leaf_hash = SHA-256(0x00 || leaf)
```

The object has exactly these keys, in this order, with no whitespace. Binary values are base64url
without padding.

| Key                                                                                                                                           | Value                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `agent_id`                                                                                                                                    | decimal uint256                                                                 |
| `alibi_id`                                                                                                                                    | ULID of the purchase                                                            |
| `cart_hash`, `countersign_digest`, `eval_hash`, `evidence_root`, `mandate_commitment`, `mandate_hash`, `paypal_ref_commit`, `policy_set_hash` | 32 bytes                                                                        |
| `issued_at`                                                                                                                                   | RFC 3339 UTC, seconds                                                           |
| `measurements`                                                                                                                                | 32-byte measurement ids, `[tdx, nitro]` or `[tdx]`                              |
| `mode`                                                                                                                                        | `2of2` or `degraded`                                                            |
| `prev_alibi_by_user`                                                                                                                          | optional, the leaf hash of the user's previous Alibi                            |
| `tee_sigs`                                                                                                                                    | 65-byte `r‖s‖v` signatures over `countersign_digest`, `[tdx, nitro]` or `[tdx]` |

Leaves are at most 1,024 bytes. The Go parser is [`internal/alibilog`](../../internal/alibilog) and the
TypeScript builder is [`@keelson/log`](../../packages/log).

## Verify with any tlog-tiles client

With [torchwood](https://pkg.go.dev/filippo.io/torchwood), a proof returned by the log
([c2sp.org/tlog-proof](https://c2sp.org/tlog-proof)) verifies against both keys:

```go
policy, _ := torchwood.ParsePolicy([]byte("log " + edVkey + "\nlog " + mldsaVkey + "\nquorum none\n"))
err := torchwood.VerifyProof(policy, tlog.RecordHash(leaf), proof)
```

Tessera's [`client`](https://pkg.go.dev/github.com/transparency-dev/tessera/client) package
(`NewLogStateTracker`, `NewProofBuilder`) reads the same tiles. `live_test.go` proves every entry
of the deployed log with both clients:

```sh
go test -tags live -run Live -v ./services/log/
```

## Run

| Variable                                        |                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `LOG_DATA_DIR`                                  | Directory of the logs; each origin uses `<dir>/<origin path>`    |
| `PORT`                                          | Public listener, read-only (default `10000`)                     |
| `LOG_PRIVATE_ADDR`                              | Write listener, `POST /<origin path>/add` (default `:8081`)      |
| `DATABASE_URL`                                  | Postgres with the API's `tee_signers` and `purchases`, read only |
| `KEELSON_VERIFYING_CONTRACT`                    | `verifyingContract` of the `Countersign` EIP-712 domain          |
| `LOG_WRITE_TOKEN_SHA256`                        | Hex SHA-256 of the bearer token the API writes with              |
| `LOG_SIGNER_KEY_SANDBOX`, `LOG_SIGNER_KEY_LIVE` | Ed25519 note signer keys                                         |
| `LOG_MLDSA_SEED_SANDBOX`, `LOG_MLDSA_SEED_LIVE` | Base64 32-byte ML-DSA-44 seeds                                   |

`go run ./services/log/cmd/keygen -origin <origin> -env SANDBOX -dir services/log/keys -name <name>`
writes a new pair of verifier keys and prints the matching secrets.

`POST /<origin path>/add` takes `{"leaf": <base64>, "countersign": <the 16 Countersign fields as
strings>}` and answers, once a checkpoint covers the leaf, `{"index", "leafHash", "proof",
"checkpoint"}`. Refusals are `422 {"code"}`: `leaf.*`, `countersign.digest`, `countersign.fields`,
`countersign.signature`, `countersign.signer`, `countersign.measurement` or `countersign.mode`.
The same leaf always gets the same index.
