# What is real and what is sandbox

Keelson runs in production on real infrastructure, but money only moves in its providers' own test
environments. Nothing in the product is simulated or mocked: the TEE quotes are real Intel TDX and
AWS Nitro attestations, the log is a public transparency log with external witnesses, and PayPal,
the card issuer and the chain are their providers' sandboxes and testnets.

## By dependency

| Dependency                                                           | Environment                                  | What that means                                                                                                                                    | Check it                                                                                |
| -------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| PayPal (Orders, Payments, Disputes, Webhooks, Payouts)               | Sandbox                                      | Holds, captures, disputes and payouts are real API calls against `api-m.sandbox.paypal.com`. No real money moves.                                  | `GET https://api.keelson.finance/status` reports `"paypal": {"environment": "sandbox"}` |
| Demo merchant (RunFast, `store.keelson.finance`)                     | Ours, PayPal sandbox checkout                | A real store we operate, with a PayPal sandbox business account and the PayPal JavaScript SDK v6. Disputes and attacks in the demo run against it. | Buy a pair at https://store.keelson.finance                                             |
| Card rail (card mandates)                                            | Sandbox                                      | The budget is held on PayPal (sandbox). The single-use card is issued by Lithic's sandbox, which also plays the card network.                      | `services/api/scripts/card-demo.ts`                                                     |
| TEE leg A, Intel TDX on Phala Cloud                                  | Production hardware                          | Real TDX quotes, checked against Intel's collateral.                                                                                               | `GET /v1/attestation` on the leg; the `tee-verify` workflow                             |
| TEE leg B, AWS Nitro Enclave                                         | Production hardware                          | Real Nitro attestation documents, signed by AWS's root.                                                                                            | `GET https://tee-b.keelson.finance/v1/attestation`                                      |
| Alibi log (`log.keelson.finance`)                                    | Production                                   | A public c2sp.org/tlog-tiles log. The sandbox origin holds every Alibi; the live origin is reserved for Arbitrum One.                              | `GET https://log.keelson.finance/alibi/2026-1/checkpoint`                               |
| Witnesses (`witness-1..3.keelson.finance`)                           | Production                                   | Three witnesses Keelson operates on three providers. They are not independent of Keelson.                                                          | The cosignature lines of any checkpoint                                                 |
| Sigsum (seasalp log, Glasklar, Mullvad and Tillitis witnesses)       | Production                                   | Every checkpoint is co-logged in a public log Keelson does not run.                                                                                | `sigsum-verify`, see [the log's README](../services/log/README.md#sigsum)               |
| Monitor                                                              | Production                                   | A public monitor Keelson operates on a separate provider. Anyone can run the same binary.                                                          | https://keelson-monitor-production.up.railway.app/report                                |
| Contracts (bond vault, reserve, verifiers, courts, anchor, log bond) | Arbitrum Sepolia testnet, test PYUSD         | Deployed and source-verified. Arbitrum One has a registry and fork tests and is not deployed.                                                      | [Deployments](../contracts/README.md#deployments) on Arbiscan                           |
| ERC-8004 registries                                                  | Arbitrum Sepolia, official v2.0.0 registries | Bonds are keyed by the agent's id in the official Identity registry.                                                                               | [packages/erc8004](../packages/erc8004/README.md)                                       |
| Claude (Anthropic API)                                               | Production                                   | The mandate compiler, the shopping agent and the red team call the real API.                                                                       |                                                                                         |
| Agent browser (Kernel)                                               | Production                                   | The shopping agent drives a real hosted Chromium.                                                                                                  |                                                                                         |
| Channel3                                                             | Production                                   | A third party's live product data, compared field by field with what the agent saw. It is a third party's testimony, not a cryptographic proof.    | [Channel3 observation](../services/api/README.md#channel3-observation)                  |
| TLSNotary (`tlsn` 0.1.0-alpha.15)                                    | Production, alpha software                   | Leg A is the notary. TLSNotary itself is alpha.                                                                                                    | [engine/tlsn](../engine/tlsn/README.md)                                                 |
| RFC 3161 timestamps                                                  | Production TSAs                              |                                                                                                                                                    | [packages/timestamp](../packages/timestamp/README.md)                                   |
| Proof generation (Noir, UltraHonk)                                   | Production                                   | C1 is proved inside leg A; C3 and C1+C3 by the API's workflows. Proofs verify on Arbitrum Sepolia.                                                 | `GET /v1/c1/{request_id}` on leg A                                                      |

## Two flows

Keelson has two flows, and they are kept apart.

**Sandbox.** The demo store is ours and its merchant account is a PayPal sandbox account. This flow
has everything: attacks, blocked purchases, PayPal sandbox disputes, signed verdicts, slashes of the
operator's bond and warranty payouts. Judge Mode (https://app.keelson.finance/judge) walks
through it.

**Live.** The shopping agent buys at real stores that accept PayPal and do not integrate Keelson.
Its click on PayPal's final payment waits for Keelson's countersignature of the checkout total, and a
cart that breaks the mandate is blocked before the click. Keelson countersigns and logs these
purchases and covers none of them; no dispute is ever opened against these stores. They are listed
at https://app.keelson.finance/live and by `GET https://api.keelson.finance/v1/live-purchases`.

> TODO: the live flow has blocked carts on record but no completed paid purchase yet. Currency
> conversion at the PayPal checkout (an optional spread cap in the mandate, checked against PayPal's
> own order before the pay click) is in progress.

## In progress

These are being built and are not live:

- **SP1 proof of the engine's evaluation for disputes.** A Groth16 proof, from the Succinct Prover
  Network, that the engine's evaluation of a disputed purchase produced the countersigned digest,
  recorded on chain.
- **Currency conversion in the live checkout**, described above.
- **Arbitrum One deployment** and the live log origin's anchoring there.
- **The monitor's checks of TEE signatures and on-chain anchors.** It reports both as
  `not-enabled` today.
