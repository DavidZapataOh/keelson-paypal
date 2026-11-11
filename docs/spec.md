# Keelson specification

This document specifies what Keelson signs, logs and enforces. It describes the deployed system;
where a part is still being built it says so. Each section links to the component that implements
it, whose README is the detailed reference.

Key words: a **mandate** is what the user allows an agent to buy; a **countersign** is the TEE legs'
signed decision on one cart; an **Alibi** is the verifiable record of that decision; a **verdict**
is the TEE legs' signed attribution of a dispute.

## 1. Primitives

| Primitive             | Definition                                                                                                                                                                                                                                | Implemented in                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Canonical JSON        | RFC 8785 (JCS)                                                                                                                                                                                                                            | `@keelson/core`, `engine/core`               |
| Domain-separated hash | `H(dst, v) = SHA-256(utf8(dst) ‖ 0x00 ‖ utf8(JCS(v)))` with `dst` one of `keelson/mandate/v1`, `keelson/mandate-challenge/v1`, `keelson/cart/v1`, `keelson/evidence-item/v1`, `keelson/eval/v1`, `keelson/alibi/v1`, `keelson/verdict/v1` | `@keelson/core` `hashObject`                 |
| Identifiers           | ULID (26 Crockford base32 characters)                                                                                                                                                                                                     | `@keelson/core`                              |
| Money                 | Integer minor units and an ISO 4217 code                                                                                                                                                                                                  | `@keelson/core`                              |
| ZK-friendly hash      | Poseidon2 over BN254                                                                                                                                                                                                                      | `@keelson/core/poseidon2`, the Noir circuits |
| Typed signatures      | EIP-712, domain `{Keelson, 1, chainId, VerdictVerifier}` for TEE messages                                                                                                                                                                 | `@keelson/core/eip712`                       |

The TypeScript and Rust implementations are pinned to the same test vectors.

## 2. Mandate

A mandate is a `keelson.mandate.1` JSON payload ([schema](../packages/mandate/src/schema.ts)). Unknown
keys and constraint types are rejected, strings exclude Unicode control and format characters, and
the lifetime is at most 30 days.

| Member                              | Meaning                                                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mid`, `iat`, `nbf`, `exp`, `nonce` | Identity and validity window                                                                                                                                                  |
| `mode`                              | `immediate` or `autonomous`                                                                                                                                                   |
| `user`                              | The user's `sub` and the passkey credential (`cred`: id, RP ID, P-256 JWK)                                                                                                    |
| `agent`                             | The operator's ERC-8004 registry and `agent_id`, the agent's confirmation key (`cnf`), and the bond (vault, asset, minimum)                                                   |
| `payment`                           | `rail` (`paypal` or `card`), currency, and constraints: `payment.amount_range`, `payment.budget`, `payment.allowed_payees`, `payment.execution_date`, `payment.card_controls` |
| `checkout`                          | Constraints: `checkout.allowed_merchants`, `checkout.line_items`, `keelson.category` (Google Product Taxonomy ids), `keelson.attributes`, `keelson.returns`                   |
| `intent`                            | The prompt's summary and hash, and the subjective wishes no machine can check                                                                                                 |
| `policy`                            | Engine, version, `policy_set_hash` and the allowed TEE measurements                                                                                                           |
| `consent`                           | Terms hash and the user's acknowledgements                                                                                                                                    |
| `zk.commitment`                     | `C_m`, the Poseidon2 commitment to the mandate's checkable fields                                                                                                             |
| `embed`                             | Present when signed inside a framed approval: the top-level origin the passkey assertion must name                                                                            |

**Selective disclosure.** The payload is issued as SD-JWT (RFC 9901), so the Alibi can show an
arbiter one field without the others.

**Signing.** `H_sd = H("keelson/mandate/v1", payload_SD)` and the passkey challenge is
`M = SHA-256("keelson/mandate-challenge/v1" ‖ 0x00 ‖ H_sd ‖ C_m)`. The user signs `M` with a
WebAuthn passkey on the RP ID `keelson.finance`, through Secure Payment Confirmation where the
browser supports it. The user signs the card rendered from the payload, not a model's summary.

**Field colors.** Each field of the card says who answers for it:

| Color | Fields                                                                    | Who answers                                              |
| ----- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| Green | agent, cart sanity, currency, total, budget, merchant, deadline, quantity | Keelson checks it; the warranty pays when it was wrong   |
| Amber | category, variant, return policy                                          | The operator attests it; its bond pays when it was wrong |
| Gray  | subjective wishes, fields the drafting models disagree on                 | Only the user can judge it                               |

Evidence can raise a field's color: a merchant-signed checkout, or zkTLS proof of a field.

**Compilation.** A natural-language request becomes a mandate through `@keelson/compiler`: two
models draft it independently, the merge is never wider than either draft, disagreements show gray,
and a third model checks the card against the request. Nothing a model returns is signed without
the user's passkey.

## 3. Policy

Mandate rules are a Cedar policy set ([engine/policy](../engine/policy/README.md)). The evaluator
fails closed, and every decision records a `keelson.eval/1` trace whose hash is `evalHash`. Extras
a user adds compile only to `forbid`. `cedar-policy-symcc` proves that the policy set states the
rules in `policy/spec.cedar`; the proof bundle is committed, checked for freshness in CI and
attested on `main`. The WebAssembly evaluator in `@keelson/policy` is pinned byte for byte to the
Rust one by a parity job.

## 4. Countersign

The engine runs in two TEE legs from one reproducible image ([engine/tee](../engine/tee/README.md)):

- **Leg A**, Intel TDX on Phala Cloud, holds the KMS root, issues credentials, keeps the budget
  ledger, reads PayPal and produces the `Observation` of each countersign.
- **Leg B**, an AWS Nitro Enclave with no network and no root, verifies everything again and
  countersigns over leg A's `Observation`.

Each leg signs every decision, ALLOW or DENY, with a secp256k1 key generated in RAM at boot. The
signed message is the EIP-712 `Countersign`:

```
Countersign(bytes32 requestId, bytes32 mandateHash, bytes32 mandateCommitment, bytes32 cartHash,
            uint256 agentId, bytes32 merchantId, uint64 amount, uint16 currency, uint8 category,
            bytes32 evidenceRoot, bytes32 evalHash, bytes32 policySetHash, uint8 decision,
            uint32 failedFieldsMask, uint40 issuedAt, uint40 expiresAt)
```

A request id is answered once per mandate: retrying the same input returns the same countersign,
and any other input under that id fails with `replay`. Leg A's budget is
`max − captured − live reservations`, with `captured` from its own PayPal read.

**Two of two.** A purchase is countersigned by both legs. When leg B is unreachable, leg A alone
signs and every artifact says `degraded`; on chain a degraded result waits a longer veto window.

**Attestation binding.** Each leg's attestation carries
`report_data = keccak256(abi.encode(keccak256("KEELSON_TEE_SIGNER_V1"), chainid, bondVault, teeKind,
signer, policySetHash, engineBuildId, bootEpoch, issuerJwkThumbprint)) ‖ blockHash`, with a recent
Arbitrum block. `VerdictVerifier` registers a signer only from such an attestation, under an
allowed measurement, for 72 hours.

## 5. Evidence

What the agent saw is sealed per item ([packages/evidence](../packages/evidence/README.md)): the
product and cart data, what the model received, a DOM snapshot in `keelson-dom-v1`, the
accessibility tree, a screenshot, MHTML, a normalized HAR, outside observations and the PayPal
amount countersigned. Each item is a salted leaf (`keelson/evidence-item/v1`) of an RFC 6962 Merkle
tree whose root is `evidenceRoot`, so one item can be shown without the others and an unrevealed
item cannot be guessed from its hash. PII is redacted from every public item (the originals are
kept encrypted), and a hidden-text detector records text a page hid from people but showed to the
agent.

Two kinds of outside testimony can be attached:

- **Channel3** (a third party's live product data), compared field by field with what the agent
  saw. It is testimony, not proof.
- **TLSNotary**: leg A notarizes a TLS session with the store's public product endpoint and signs a
  `WebFact` (`hostHash`, `urlPathHash`, `tCapture`, `rangeCommitment`, `attId`). TLSNotary is alpha.

## 6. Alibi

An Alibi ([packages/alibi](../packages/alibi), [apps/verify](../apps/verify/README.md)) is the bundle
that lets anyone check a purchase without trusting Keelson: the log leaf, its inclusion proof, the
on-chain anchor, both TEE attestations and signatures, the selectively disclosed mandate, the
evidence manifest, the evaluation trace, optional ZK proofs, card records and PayPal references.
It is served as JSON, as a `.alibi` file and as a PDF with the file embedded and a QR link to
`verify.keelson.finance`.

The verifier runs in the browser against trust roots pinned in code: the log keys and witness
quorum, the TSA roots, Intel's and AWS's attestation roots, the allowed engine builds, and the
contract addresses. It reads the chain once, in one Multicall.

## 7. Transparency log

Every countersign, ALLOW or DENY, is a leaf of a public log ([services/log](../services/log/README.md)):

```
leaf      = "keelson.finance/alibi/v1\n" ‖ JCS(object)
leaf_hash = SHA-256(0x00 ‖ leaf)
```

The object holds hashes and ids only: `agent_id`, `alibi_id`, `cart_hash`, `countersign_digest`,
`eval_hash`, `evidence_root`, `issued_at`, `mandate_commitment`, `mandate_hash`, `measurements`,
`mode`, `paypal_ref_commit`, `policy_set_hash`, optional `prev_alibi_by_user`, and `tee_sigs`. A
user's kill switch is logged as a `keelson.finance/stop/v1` leaf.

| Property        | How                                                                                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format          | c2sp.org/tlog-tiles on Tessera                                                                                                                                                                                                                        |
| Origins         | `log.keelson.finance/alibi/2026-1` (Arbitrum Sepolia), `log.keelson.finance/alibi-live/2026-1` (Arbitrum One, not yet anchored)                                                                                                                       |
| Log signatures  | Ed25519 and ML-DSA-44 on every checkpoint. The Ed25519 key is derived inside leg A from the dstack KMS and never leaves it                                                                                                                            |
| Witnesses       | 2 of 3 Keelson-run witnesses on three providers cosign every published checkpoint                                                                                                                                                                     |
| External record | Checkpoints co-logged hourly in Sigsum's seasalp log, cosigned by Glasklar, Mullvad and Tillitis witnesses                                                                                                                                            |
| Anchoring       | `CheckpointAnchor` accepts a witnessed checkpoint signed by both TEE legs, with an RFC 6962 consistency proof from the previous anchor; at least hourly or every 1,000 leaves                                                                         |
| Equivocation    | `LogBond.proveEquivocation(noteA, noteB)` slashes the log's PYUSD bond when two checkpoints signed by its key state different roots for one size, verified on chain with an Ed25519 verifier; 10% goes to the prover and the rest to `KeelsonReserve` |
| Monitoring      | A public monitor checks signatures, quorum, consistency, every leaf's format and inclusion, and the Sigsum co-logging. Anyone can run it                                                                                                              |

## 8. PayPal

PayPal is the rail. Keelson uses the Orders v2 and Payments v2 APIs with `intent: AUTHORIZE`
([packages/paypal](../packages/paypal), [services/api](../services/api/README.md)):

1. **Hold.** One `AUTHORIZE` order per mandate for its cap, approved with the JavaScript SDK v6,
   then authorized. A cart can instead get its own hold (one order per cart), which a mandate over
   several merchants requires.
2. **Capture.** Each countersigned ALLOW is captured from the hold for exactly the countersigned
   total, with `final_capture` true only for the capture that uses up the hold (or for a
   per-cart hold), `invoice_id` naming the purchase and `PayPal-Request-Id` derived from the
   countersign digest, so a retry cannot charge twice.
3. **Close.** The remainder is voided when the mandate ends; an authorization older than three days
   is reauthorized.
4. **Webhooks** are verified in-house and only point at a resource, which is re-read with an
   authenticated `GET`.
5. **Disputes** are read, evaluated and answered through the Disputes API (§10).
6. **Refunds and Payouts** carry a verdict reference, so a retry is the same operation.

The identifiers Keelson writes into PayPal objects are an open convention, specified in
[the PayPal Agent Mandate Extension](paypal-agent-mandate-extension.md).

**Card rail.** A mandate with `payment.rail: card` holds its budget on PayPal the same way and pays
merchants that take cards through a single-use card: issued only after both legs ALLOW, capped at
the countersigned total, limited to the mandate's merchant category codes and country. Every
authorization the card network sends is checked again by both legs (`POST /v1/card/authorize`),
and the settled charge is captured from the PayPal hold. See [architecture](architecture.md#card-mandates).

## 9. On chain

Contracts are on Arbitrum Sepolia ([contracts](../contracts/README.md)), unaudited:

| Contract                                                                | Role                                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `VerdictVerifier`                                                       | Registers TEE signers from attestations (Automata DCAP for TDX, a Nitro validator) and verifies 2-of-2 and degraded signatures |
| `KeelsonBondVault`                                                      | Holds each operator's PYUSD bond by ERC-8004 `agentId`, locks a coverage per purchase, and slashes on a verdict                |
| `KeelsonReserve`                                                        | ERC-4626 vault of premiums, which pays warranties when Keelson is at fault                                                     |
| `CheckpointAnchor`                                                      | Anchors witnessed checkpoints, enforcing consistency                                                                           |
| `LogBond`                                                               | Puts PYUSD behind the log's key                                                                                                |
| `MandateViolationCourt`, `AmberContradictionCourt`, `ViolationBondPool` | Convictions from ZK proofs, without the TEEs                                                                                   |
| ZK verifiers                                                            | UltraHonk verifiers for C1, C2a, C2b, C3 and C1+C3, each with a reference build                                                |
| `RegisteredUserSet`                                                     | Roots of the registered-user tree, for C3                                                                                      |
| `KeelsonReputationReporter`, `KeelsonValidationRegistry`                | ERC-8004 reputation and validation records                                                                                     |

Governance: a timelock (5 minutes on testnets, 48 hours on Arbitrum One) administers the access
manager; a 2-of-3 guardian Safe can cancel, veto slashes and revoke signers. A relayer pays gas, so
operators, merchants and buyers never hold ETH.

## 10. Disputes and attribution

A PayPal dispute is attributed by an ordered decision list compiled to Cedar, with symcc proofs
that it is total, exclusive and reachable ([table](../engine/policy/README.md#dispute-attribution)):

| Party at fault | Rules                                                                  | Consequence               |
| -------------- | ---------------------------------------------------------------------- | ------------------------- |
| Operator       | R00 (a proof fails), R31 (double capture), R61 (amber field failed)    | Bond slashed              |
| Keelson        | R30 (single-use mandate countersigned twice), R60 (green field failed) | Reserve pays the warranty |
| Merchant       | R11, R21, R35, R40, R50                                                | Evidence to PayPal        |
| User           | R10, R20, R32, R62, R70                                                | Evidence to PayPal        |

Both legs sign the EIP-712 `Verdict`:

```
Verdict(bytes32 disputeId, bytes32 coverageId, uint256 agentId, address payee, uint96 amount,
        uint8 ruleId, uint8 liable, uint8 fieldId, bytes32 evidenceHash, bytes32 inputsHash,
        bytes32 policySetHash, bytes32 checkpointRoot, uint40 issuedAt, uint40 deadline)
```

with `disputeId = keccak256(paypalDisputeId ‖ coverageId)` as a nullifier. A merchant is settled in
PYUSD on chain or by PayPal Payout, as it chooses. **PayPal adjudicates the dispute**; the verdict
decides the evidence, the slash and the warranty.

## 11. Zero-knowledge circuits

Noir circuits proved with Barretenberg UltraHonk ([circuits](../circuits)):

| Circuit                    | Statement                                                                                               | Status                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| C1 `mandate_predicate`     | The countersigned cart satisfies the mandate `C_m` commits to, without revealing it                     | Proved inside leg A for an ALLOW; verifier on chain |
| C2a `mandate_violation`    | A countersigned cart violates its mandate (amount, currency, category, expiry, merchant non-membership) | `MandateViolationCourt` on chain                    |
| C2b `amber_contradiction`  | A notarized TLS response contradicts an amber field the operator attested                               | `AmberContradictionCourt` on chain                  |
| C3 `anonymous_mandate`     | A registered user's passkey signed the mandate, without revealing which user                            | Proved by the API; verifier on chain                |
| C1+C3 `anonymous_purchase` | C1 and C3 composed by recursion in one proof                                                            | Proved by the API; verifier on chain                |
| SP1 engine proof           | The engine's evaluation of a disputed purchase produced the countersigned digest                        | In progress                                         |

## 12. Agents

Agents reach Keelson over REST or MCP (`https://api.keelson.finance/mcp`, Streamable HTTP), an
OAuth 2.1 protected resource. An operator's agent uses client credentials and closes mandates with
its own key; a host acting for a user uses the authorization code grant with PKCE and buys only
under mandates the user approved for it. The kill switch, per-host disconnects, and push and email
alerts are described in [architecture](architecture.md#agents-and-hosts). The OpenAPI document is in
[`openapi/`](../openapi).

## 13. Risk

Every operator has a trust grade, a premium and a minimum bond, set by the red team's results and
its own record (`GET /v1/operators/{agentId}/grade`; see
[Risk model](../services/api/README.md#risk-model)).

## 14. Limits

See [Limits we state plainly](threat-model.md#limits-we-state-plainly).
