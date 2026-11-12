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
A new checkpoint is published every 500 ms while the log grows, and every minute otherwise.

## Witnesses

Every checkpoint carries the cosignatures ([c2sp.org/tlog-cosignature](https://c2sp.org/tlog-cosignature),
`cosignature/v1`) of at least two of the three witnesses operated by Keelson, each on a different
provider. A checkpoint without that quorum is not published: the log waits at most one second for the
witnesses, and an append that no witnessed checkpoint covers answers `503`. The witnesses run
[litewitness](../witness) and refuse any checkpoint that is not consistent with the last one they
cosigned.

The three witnesses are operated by Keelson, so they are not independent of each other or of the
log: they keep a log whose keys leaked from showing a split view without their keys too, and they
make each checkpoint a fact on three providers, but they do not protect anyone from Keelson itself.
The independent record is [Sigsum](#sigsum): each checkpoint co-logged there is cosigned by
witnesses Keelson does not run, and anyone can [run the monitor](../monitor#run-your-own-monitor).

| Witness                     | Provider              |
| --------------------------- | --------------------- |
| `witness-1.keelson.finance` | Render (Oregon)       |
| `witness-2.keelson.finance` | Railway (US West)     |
| `witness-3.keelson.finance` | AWS EC2 (`us-west-2`) |

Each origin publishes its policy at `https://<origin>/policy`, in the
[Sigsum policy format](https://git.glasklar.is/sigsum/core/sigsum-go/-/blob/main/doc/policy.md) that
Tessera and torchwood read: the log keys, the witnesses' `cosignature/v1` keys and URLs, and
`quorum own` (two of three). The same files are in [`policy/`](policy). With torchwood:

```go
policy, _ := torchwood.ParsePolicy(policyFile)
checkpoint, _, err := torchwood.VerifyCheckpoint(signedCheckpoint, policy)
```

`log.keelson.finance/conformance/2026-1` is a test-only log the witnesses also cosign. Entry _i_ is
`keelson conformance <i>` ([`internal/conformance`](../../internal/conformance)), so a client holding
its key can rebuild the tree at any size and check that every witness refuses forks and rollbacks.
Its key is [`keys/conformance-2026-1.vkey`](keys/conformance-2026-1.vkey); it holds no Alibis.

## Receipts

Each `add` answer also carries an [RFC 9942](https://www.rfc-editor.org/rfc/rfc9942) receipt of the
leaf (`receipt`, base64) in the same checkpoint: a `COSE_Sign1` with an Ed25519 (`-19`) signature over
the detached tree root, `vds` `RFC9162_SHA256` (`1`) and the leaf's inclusion path. The proof is the
one the `tlog-proof` carries, so both prove the same inclusion; the witnesses' cosignatures stay in the
checkpoint. A one-leaf tree gets no receipt (RFC 9942 needs a non-empty path).

The receipt key is not the checkpoint key. Leg A holds it for the origins it signs and returns its
root signature with each checkpoint signature; the log checks it against `LOG_RECEIPT_KEY_<env>` (hex)
before using it. The keys are served as a COSE_KeySet at `/.well-known/scitt-keys`
([SCRAPI](https://datatracker.ietf.org/doc/draft-ietf-scitt-scrapi/)). Its protected header is
`{1: -19, 4: SHA-256(key), 15: {1: "https://log.keelson.finance", 2: <origin>}, 395: 1}`.

Leaves are either the JCS leaves (`keelson.finance/alibi/v1`) or SCITT signed statements
([RFC 9943](https://www.rfc-editor.org/rfc/rfc9943)): admission checks both the same way.

## Sigsum

Checkpoints are co-logged in the [Sigsum](https://www.sigsum.org) log
[seasalp](https://git.glasklar.is/glasklar/services/sigsum-logs/-/blob/main/instances/seasalp.md),
cosigned by Glasklar, Mullvad and Tillitis witnesses (two of three, [`policy/sigsum-seasalp.policy`](policy/sigsum-seasalp.policy)).
The Sigsum message is the SHA-256 of the checkpoint body (the origin, size and root lines), signed
with [`keys/sigsum-submit.pub`](keys/sigsum-submit.pub); the same key, published in the
`_sigsum_v1.keelson.finance` TXT record, is the rate-limit key.

The log co-logs an origin every hour when it grew, and on `POST /<origin path>/sigsum` (private,
bearer): `202 {"size"}` when a submission starts, `200 {"size", "proof"}` when that checkpoint is
already co-logged, `429 {"size", "retryAfter"}` otherwise. Submissions are at least five minutes
apart across origins and restarts, so the log stays under seasalp's 288 entries a day.

Each co-logged checkpoint is public at `https://<origin>/sigsum/<size>.msg` with its proof at
`<size>.proof`. With the official [`sigsum-verify`](https://git.glasklar.is/sigsum/core/sigsum-go/-/blob/main/doc/tools.md):

```sh
curl -s https://log.keelson.finance/alibi/2026-1/sigsum/<size>.msg |
  sigsum-verify -k keys/sigsum-submit.pub -p policy/sigsum-seasalp.policy <size>.proof
```

## Anchors

Witnessed checkpoints are anchored in `CheckpointAnchor`
(`0x049621749722D0660d5026456F25192fBD9A57ab`, the same CREATE3 address on every chain), which
accepts a checkpoint only with both TEE legs' signatures over its EIP-712 `Checkpoint` and an RFC
6962 consistency proof from the origin's previous anchor, so a rewritten history cannot be
anchored. The sandbox origin anchors on Arbitrum Sepolia; the live origin anchors on Arbitrum One
once `ARBITRUM_ONE_RPC_URL` is set and a leg pair is registered there.

Every 10 seconds the log compares each origin's published checkpoint with its latest anchor and
anchors it when the log grew and either an hour passed since the last anchor or 1,000 leaves were
added. `POST /<origin path>/anchor` (private, bearer) anchors now and answers
`200 {"size", "root", "tx", "fresh"}` (`fresh: false` with the latest anchor when there is
nothing new), `503 {"code": "tee_unavailable"}` when a leg does not sign and
`502 {"code": "chain"}` when the chain cannot be reached. `GET /health` reports each origin's
`anchoredSize`. Anchors are sent from `ANCHOR_SUBMITTER_KEY`, which has no on-chain privilege.

Check an anchor with Foundry's `cast`:

```sh
origin=$(cast keccak "log.keelson.finance/alibi/2026-1")
cast call 0x049621749722D0660d5026456F25192fBD9A57ab "latest(bytes32)(uint64,bytes32,uint40)" $origin \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc
cast call 0x049621749722D0660d5026456F25192fBD9A57ab "rootAt(bytes32,uint64)(bytes32)" $origin <size> \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc
```

The signed note of each anchor is the `signedNote` argument of its transaction, and the
`CheckpointAnchored` event carries its `keccak256`.

## Bonds

A `LogBond` ([contracts](../../contracts#deployments)) puts PYUSD behind an origin's Ed25519 key:
two checkpoints of the origin signed by the key, with different roots for the same size, pay the
whole bond to whoever submits them to `proveEquivocation`. The contract verifies both signatures
on chain. A split view the monitor publishes (`GET /equivocations/<id>`, kind `same-size`) is
exactly that pair:

```sh
cast send <bond> "proveEquivocation(bytes,bytes)" "$(printf %s "$a" | xxd -p | tr -d '\n' | sed 's/^/0x/')" \
  "$(printf %s "$b" | xxd -p | tr -d '\n' | sed 's/^/0x/')" --rpc-url https://sepolia-rollup.arbitrum.io/rpc
```

`GET https://api.keelson.finance/v1/log/bonds` lists every bond with its balance and, once slashed,
the two checkpoints and the transaction. The conformance origin's bond was slashed by a drill with
its tree and a fork of it at size 8.

## Hosting

The service runs on Render with its log on a persistent disk, behind Cloudflare. The write
listener is reachable only over Render's private network. Full and partial tiles never change,
so the log serves them with `Cache-Control: public, max-age=31536000, immutable`; `checkpoint` is
`no-cache`. A Cloudflare Cache Rule on `(http.host eq "log.keelson.finance" and
http.request.uri.path contains "/tile/")` makes tiles eligible for the edge cache, and both edge
and browser TTLs follow the origin's `Cache-Control`. SSL/TLS mode is Full.

## Operations

| Piece                       | Where                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Log                         | Render `keelson-log`, Oregon, `0.5c-512mb` with a 10 GB disk at `/var/lib/keelson-log`, behind Cloudflare; write listener on Render's private network   |
| Witness 1                   | Render `keelson-witness-1`, Oregon, `0.5c-512mb` with a 1 GB disk                                                                                       |
| Witness 2                   | Railway `keelson-witness-2`, US West, with a volume                                                                                                     |
| Witness 3                   | AWS `us-west-2`: a container (`keelson-witness-3` systemd unit) on the Nitro leg's parent instance, its key in SSM at `/keelson/witness-3/key`          |
| Monitor                     | Railway `keelson-monitor`, operated by Keelson at <https://keelson-monitor-production.up.railway.app>; anyone can run their own ([monitor](../monitor)) |
| Independent co-log          | Sigsum `seasalp`, cosigned by Glasklar, Mullvad and Tillitis witnesses                                                                                  |
| Timestamps                  | DigiCert and Sigstore, with FreeTSA and Sectigo as fallbacks ([`@keelson/timestamp`](../../packages/timestamp))                                         |
| Third-party product reading | Channel3 lookups and offer webhooks ([API](../api#channel3-observation))                                                                                |
| Agent browser               | KERNEL headless browsers over CDP ([`@keelson/evidence`](../../packages/evidence))                                                                      |

**Restart the log.** Restart or redeploy `keelson-log` on Render. The disk keeps the tiles, the
entry bundles and the antispam index, so the log resumes at the same size and root; check with
`curl -s https://log.keelson.finance/alibi/2026-1/checkpoint` before and after. A leaf appended
again after a restart gets its old index.

**Replace a witness.** Generate a key, give it to the witness's host (`WITNESS_KEY`; for witness 3
the SSM parameter), deploy it with the `witness-deploy` workflow (witness 3: [`aws/deploy.sh`](../witness/aws/deploy.sh)), and
put its new `vkey` in every policy in [`policy/`](policy) and in the monitor's pinned
[`policy/`](../monitor/policy). Then redeploy the log and the monitor. A witness that lost its
database must not come back under its old key: it would cosign a rolled-back tree.

**Read the monitor's alerts.** `GET /report` lists the findings of each origin, and
`GET /equivocations` every split view the monitor caught, each with the two conflicting checkpoints
([API](../monitor#api)). The `monitor-deploy` workflow runs
the live checks after each deploy, and the nightly workflow checks the cache headers and every
public leaf.

**Drain pending timestamps.** Hashes whose TSAs were down stay `pending` in `timestamps`; the API's
stamp worker sweeps them every 30 seconds and asks the fallback TSA once a primary has failed three
rounds. Starting the API runs a sweep at once.
`select tsa, count(*) from timestamps where status = 'pending' group by tsa` shows what is left.

**Recreate the Channel3 subscriptions.** With `CHANNEL3_API_KEY` set, `node scripts/channel3-subscribe.ts`
in `services/api` subscribes every SKU in `channel3-skus.json` again; it is free and idempotent.

**Rotate `CHANNEL3_WEBHOOK_SECRET`.** Rotate the endpoint's secret in Channel3's webhook portal,
set the new `whsec_` value on the Render service `keelson-api` and redeploy it, then send a test
event from the portal: the API answers it `204`.

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

### Stop leaves

When a user stops every agent at once, the API appends a stop leaf through `POST /<origin>/stop`
(the private listener, with the write token). A stop carries no TEE countersign: it is Keelson's
own assertion, and what it commits Keelson to is checkable. The API appends it once no purchase of
the stopped mandates can still be logged:

```
leaf = "keelson.finance/stop/v1\n" || JCS({issued_at, mandate_count, mandates_digest, stop_id})
mandates_digest = SHA-256(mandate_hash_1 ‖ … ‖ mandate_hash_n), sorted bytewise, no repeats
```

`stop_id` is a ULID, `issued_at` RFC 3339 UTC seconds, `mandate_count` the number of hashes. The
API publishes the stopped mandate hashes with the stop, so anyone can recompute the digest and check
that no Alibi leaf at a later index carries one of them. One `stop_id` gets one leaf, as one
purchase does. The monitor counts a well-formed stop leaf as no finding.

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

The witness and Sigsum tests among them need `LOG_SIGNER_KEY_CONFORMANCE`, `SIGSUM_SUBMIT_KEY` and
Postgres (`DATABASE_URL`).

## Run

| Variable                                          |                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `LOG_DATA_DIR`                                    | Directory of the logs; each origin uses `<dir>/<origin path>`                                    |
| `LOG_POLICY_DIR`                                  | Witness policies, `<origin path, / as ->.policy`, and `sigsum-seasalp.policy` (image: `policy/`) |
| `PORT`                                            | Public listener, read-only (default `10000`)                                                     |
| `LOG_PRIVATE_ADDR`                                | Write listener, `POST /<origin path>/add` (default `:8081`)                                      |
| `DATABASE_URL`                                    | Postgres with the API's `tee_signers` and `purchases`, read only                                 |
| `KEELSON_VERIFYING_CONTRACT`                      | `verifyingContract` of the `Countersign` EIP-712 domain                                          |
| `LOG_WRITE_TOKEN_SHA256`                          | Hex SHA-256 of the bearer token the API writes with                                              |
| `LOG_SIGNER_KEY_SANDBOX`, `LOG_SIGNER_KEY_LIVE`   | Ed25519 note signer keys, for an origin whose key the log holds                                  |
| `LOG_SIGNER_VKEY_SANDBOX`, `LOG_SIGNER_VKEY_LIVE` | The origin's Ed25519 verifier key when leg A holds it; the log then has leg A sign over RA-TLS   |
| `LOG_REMOTE_SIGNER_URL`, `KEELSON_TEE_TOKEN`      | Leg A's RA-TLS address (`https://<app id>-8443s.<gateway domain>`) and the legs' bearer token    |
| `LOG_MLDSA_SEED_SANDBOX`, `LOG_MLDSA_SEED_LIVE`   | Base64 32-byte ML-DSA-44 seeds                                                                   |
| `SIGSUM_SUBMIT_KEY`                               | OpenSSH Ed25519 key that co-logs checkpoints in Sigsum; unset, co-logging is off                 |

`KEELSON_VERIFYING_CONTRACT` must equal the API's `verifyingContract`; when the contract is
deployed, both change together, or every leaf is refused with `countersign.digest`.

`go run ./services/log/cmd/keygen -origin <origin> -env SANDBOX -dir services/log/keys -name <name>`
writes a new pair of verifier keys and prints the matching secrets.

`POST /<origin path>/add` takes `{"leaf": <base64>, "countersign": <the 16 Countersign fields as
strings>}` and answers, once a checkpoint covers the leaf, `{"index", "leafHash", "proof",
"checkpoint"}`. Refusals are `422 {"code"}`: `leaf.*`, `countersign.digest`, `countersign.fields`,
`countersign.signature`, `countersign.signer`, `countersign.measurement` or `countersign.mode`.
A purchase has one leaf in the log: the same leaf again gets the same index and a fresh proof,
and another leaf with the same `alibi_id` is refused with `409 {"code": "leaf.duplicate"}`.
