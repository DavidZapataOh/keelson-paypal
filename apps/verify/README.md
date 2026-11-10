# Alibi verifier

`https://verify.keelson.finance` checks a Keelson Alibi in the browser. You do not have to trust
Keelson's servers to use it. Every check comes from `@keelson/alibi/verify`, the same module the API
uses before it issues an Alibi.

## What it takes

- **The PDF.** The verifier reads the `.alibi` file embedded in it, using pdf.js in a worker.
- **The `.alibi` file or its JSON.** You can drop the file or paste the JSON.
- **A photo of the QR code.** This needs `BarcodeDetector`, which Chromium has. In other browsers,
  open the link instead.
- **The QR link.** Its form is `/a/<alibi_id>#<leaf hash>.<anchored size>.<chain id>`, and
  `/v/<alibi_id>#…` is also accepted. A link on its own loads the public receipt from
  `GET https://api.keelson.finance/v1/alibis/{id}/receipt`. It covers the log leaf, the inclusion
  proof, the anchor and the timestamps. The other checks show "Not disclosed to you" until you drop
  the full Alibi. The link's fragment stays in the browser and never reaches a server.

Inputs over 8 MB are refused, as is JSON nested deeper than 64 levels or containing `__proto__`,
`constructor` or `prototype` keys.

## What is verified, and against what

The trust roots are pinned in code. A bundle cannot bring its own:

| Root                                                      | Where it is pinned                                                |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| Log origins, Ed25519 and ML-DSA-44 keys                   | `@keelson/log` `LOG_ORIGINS`, `LOG_VKEYS`                         |
| Witness keys and the 2-of-3 quorum                        | `@keelson/log` `LOG_WITNESSES`                                    |
| RFC 3161 TSA roots                                        | `@keelson/timestamp` `TSA_ROOTS`                                  |
| Intel and AWS attestation roots, engine builds            | `@keelson/attest`; builds in `packages/alibi/src/verify/trust.ts` |
| `CheckpointAnchor`, `VerdictVerifier`, `KeelsonBondVault` | `@keelson/chain` `deploymentsFor(chainId)`                        |

The chain is read once per verification, in a single HTTP request:

- `rootAt` and `latest` of the anchor;
- the signer records and measurement allowances in `VerdictVerifier`;
- `eth_chainId`, the block number and the anchor transaction's receipt.

The contract reads go through Multicall3 in one `eth_call`.

By default the verifier reads from two public Arbitrum RPCs:

- `https://sepolia-rollup.arbitrum.io/rpc`;
- `https://arbitrum-sepolia-rpc.publicnode.com`, as a fallback.

To use your own RPC, enter it in the field at the bottom of the page. Only `https:` URLs are
accepted. A link's `?rpc=` only fills that field: the verifier never switches RPC without you, and it
keeps your RPC out of the URL. The RPC is trusted for what it reads, so use one you trust to
check revocations and anchors. Everything else the Alibi proves (witnessed checkpoints, consistency,
attestations, the countersignature) does not depend on it.

The default RPCs see your IP address and which checkpoint and signers you asked about, but not
which Alibi. If the RPC is down or answers for another chain, the chain checks are `unreachable` and the verdict
is `incomplete`, never `verified`. `/paypal/capture_id` is the one field no signature or hash
covers, because PayPal assigns it after the countersign. The page shows it under "Unverified
metadata".

## Try to cheat

You can edit any field of a local copy. The leaf and the SD-JWT disclosures are shown as JSON. The
copy is re-verified when you commit an edit (Enter or leaving the field). Each failing check names
the edited pointers it read. Edits never leave the page. The chain answer is reused unless the edit
changes what is read from the chain.

## Embedding

`?embed` on a link (`/a/<alibi_id>?embed#…`) shows only the cheats that apply to the loaded Alibi and
its report, with a link to the full verifier. keelson.finance frames it this way over a sandbox
purchase's public receipt; the receipt's cheats edit the log leaf (`/leaf/cart_hash`,
`/leaf/agent_id`) or the anchor (`/anchor/anchored_root`).

## Environments

Alibis come from Keelson's sandbox:

- purchases use the PayPal sandbox;
- anchors and the signer registry are on Arbitrum Sepolia (421614);
- the log is `log.keelson.finance/alibi/2026-1`.

## Run it

```sh
pnpm install
pnpm turbo run build --filter=@keelson/verify
pnpm --filter @keelson/verify preview   # http://localhost:4173
pnpm --filter @keelson/verify test      # unit tests and Chromium end to end, under the site's CSP
```

The site is a Render static site (`keelson-verify` in `render.yaml`). It rewrites `/a/*` and `/v/*`
to the app and serves `/assets/*` as immutable. Its CSP allows framing only from
`https://keelson.finance`.
