# Leg A on Phala Cloud

`docker-compose.yml` runs the engine image on an Intel TDX CVM, `tdx.small`, on dstack with the Phala KMS. The image is pinned by digest; the digest also appears as `KEELSON_OCI_DIGEST`, so the engine binds the same build id it was started from, and both are measured into the CVM's `compose-hash`.

## Secrets

Three values reach the CVM, all as Phala encrypted environment variables (encrypted on the client to the CVM's KMS key, readable only inside the TEE):

| Variable                   | Value                                            |
| -------------------------- | ------------------------------------------------ |
| `PAYPAL_CLIENT_ID`         | PayPal REST app client id                        |
| `PAYPAL_CLIENT_SECRET`     | PayPal REST app secret                           |
| `KEELSON_TEE_TOKEN_SHA256` | hex SHA-256 of the bearer token the API presents |

None of them is in the compose file or the image. Updating them replaces the whole set. The sandbox is used unless `PAYPAL_ENV=live` is also passed.

## Deploy

The `tee-deploy` workflow does this from a digest published by `tee-image`:

1. It rewrites both digests in `docker-compose.yml`.
2. `phala deploy` creates the CVM (or, when `app.json` names one, updates it in place) with `--wait`.
3. It writes the CVM's facts to `app.json` and runs `tee-verify` against the new URL.

By hand, with `PHALA_CLOUD_API_KEY` set and the three variables in `engine.env`:

```sh
npx phala@1.2.1 deploy -n keelson-engine -c docker-compose.yml -t tdx.small --kms phala \
  --image dstack-0.6.1 --no-public-logs -e engine.env
npx phala@1.2.1 deploy --cvm-id <app_id> -c docker-compose.yml -e engine.env --wait   # update
```

`--image dstack-0.6.1` matters: without it Phala picks a dev OS image of dstack 0.5, which has no v1 guest API. Phala assigns the node (a US West node today).

An update keeps the app id, so the KMS gives it the same root: credentials issued before it still verify, and the sealed records on the `data` volume are still there.

## Verify

`tee-verify` runs after a deploy and whenever `app.json` changes on `main`. It takes the app id (from `app.json` unless given) and finds the engine's URL, `https://<app_id>-8080.<gateway domain>`, from Phala:

- `scripts/verify-tdx.ts` checks the quote against Intel's collateral with `@phala/dcap-qvl` (TCB status `UpToDate`; `SWHardeningNeeded` is accepted and printed with its advisories), replays the event log into RTMR3 and compares it with the quote, and compares the `compose-hash` event with the hash of the compose file Phala holds for the CVM.
- `tests/tdx_live.rs`, against a `dstack-verifier` service container, checks that the attestation is valid and binds the signer to a recent Arbitrum Sepolia block.

A CVM behind the gateway cannot run with `no_instance_id`, so the log carries an `instance-id` event; the allowlist is the `app-id`, the `compose-hash` and the OS image hash.

## Measure

`scripts/rtt.ts <url>` prints the round-trip percentiles of `GET /v1/health`, which has no PayPal read. Run it from the region of the caller.
