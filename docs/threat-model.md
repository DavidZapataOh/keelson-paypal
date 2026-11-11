# Threat model

Who can attack a purchase made by an AI agent under a Keelson mandate, what each can try, and what
stops it. Rule numbers (R00 to R70) refer to the dispute attribution table in
[engine/policy](../engine/policy/README.md#dispute-attribution).

## Parties

- **User**: signs the mandate with a passkey and may dispute a purchase.
- **Agent operator**: runs the agent, posts a PYUSD bond and answers for what its agent attests.
- **Merchant**: sells, captures and ships.
- **Keelson**: runs the API, the TEE legs, the log and the relayer.
- **PayPal**: moves the money and adjudicates disputes.
- **Hardware vendors**: Intel (TDX) and AWS (Nitro).

## Attacks and defenses

| Adversary                            | Attack                                                      | What stops it                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious page                       | Prompt injection ("buy the $340 bundle")                    | The countersign is decided by the deterministic Cedar evaluation in both TEEs, not by a model. The evidence pipeline's hidden-text detector puts concealed instructions on the record.                                                                                                    |
| Malicious page                       | Fake scarcity to push the price up within the mandate's cap | **Not detected deterministically.** It is within what the user allowed. Such fields are amber or gray, never green.                                                                                                                                                                       |
| Agent operator                       | Attests a false item, size or price (an amber field)        | The operator's bond: R61 slashes it. With a notarized TLS response from the store, `AmberContradictionCourt` (C2b) convicts without trusting Keelson or the operator.                                                                                                                     |
| Agent operator                       | Captures twice                                              | `PayPal-Request-Id` is derived from the countersign, so PayPal treats a retry as the same capture. A second capture under one countersign is R31 and slashes the bond.                                                                                                                    |
| Agent operator                       | Buys outside the mandate                                    | Both legs DENY. If a countersigned cart still broke the mandate, `MandateViolationCourt` (C2a) convicts from the mandate's opening, without trusting Keelson.                                                                                                                             |
| Agent operator or Keelson            | Adds a `permit` to widen the mandate                        | Policy extras compile only to `forbid`. symcc proves the policy set states the mandate rules, and the seeded `extra-permit` bug is caught.                                                                                                                                                |
| Merchant                             | Ships something else, or captures another amount            | R50 and R40 make the merchant liable. The evidence holds the snapshot the agent saw and the countersigned total.                                                                                                                                                                          |
| User                                 | Friendly fraud ("I did not authorize this")                 | R70: the passkey assertion over the mandate and the Alibi go to PayPal through `provide-evidence`.                                                                                                                                                                                        |
| Keelson insider                      | Rewrites the log to blame the user                          | Witnesses refuse inconsistent checkpoints. `CheckpointAnchor` reverts without a consistency proof from the previous anchor. Sigsum keeps an external copy. The monitor publishes any split view, and `LogBond.proveEquivocation` slashes the log's bond with two conflicting checkpoints. |
| Keelson insider                      | Signs a false verdict                                       | Slashes and warranties need both TEE signers, whose keys are generated inside the enclaves and never leave. Large or degraded slashes wait a veto window, and the vault rate-limits them. The ZK courts convict without the TEEs.                                                         |
| Keelson insider or API token holder  | Pushes a made-up log extension to leg A                     | Leg A signs each tree size once, with one successor, and only extensions with a valid consistency proof. A fork then shows as two views of one origin, which the witnesses, the monitor and `LogBond` turn into proof.                                                                    |
| Hardware vendor or physical attacker | Forges a TDX quote (TEE.fail, 2025)                         | Every countersign and verdict needs a TDX signer and a Nitro signer, under two vendors' roots of trust. A degraded (TDX-only) result is marked as such and waits a longer veto window on chain.                                                                                           |
| Network attacker                     | Spoofs a PayPal webhook                                     | The signature is verified in-house: a pinned certificate chain, RSA-SHA256, a five-minute window. Its body is only a pointer: state changes come from re-reading the resource with an authenticated `GET`.                                                                                |
| Replay                               | Reuses a countersign, verdict or claim                      | Request ids bound to the digest of the whole request, `expiresAt`, nonces, the dispute nullifier `disputeId`, single-use claim ids, and single-use cards.                                                                                                                                 |
| Paxos (PYUSD issuer)                 | Freezes the vault, the payee or the reserve                 | Failed transfers become `claimable` pull payments. A merchant can settle by PayPal Payout instead.                                                                                                                                                                                        |
| Mandate compiler (a model)           | Translates the user's words into the wrong mandate          | The user signs the card rendered from the payload, not the model's text. Two models draft the mandate independently, the merge is never wider than either draft, fields they disagree on show gray, and a third model checks the card against the request.                                |
| An app acting for a user             | Asks for a mandate the user did not want                    | The user approves every request with a passkey. Alerts go out by push and email. The kill switch stops every agent. Apps on the hosted operator are capped per user and in total.                                                                                                         |

## Limits we state plainly

1. **PayPal adjudicates disputes.** Keelson's verdict decides the evidence, the slash and the
   warranty. It does not bind PayPal.
2. **Keelson is not insurance.** The warranty covers errors in Keelson's own countersign (green
   fields). Amber fields are paid by the operator's bond. Gray fields are the user's.
3. **Everything runs on sandboxes and testnets.** See [environments](environments.md).
4. **The witnesses Keelson runs are not independent of Keelson.** Independence comes from Sigsum's
   witnesses and from anyone running the monitor.
5. **Price manipulation within the cap is not detected deterministically.** It is never green.
6. **Cedar's proofs are about its Lean model**, with differential testing against the Rust code,
   which is not formally verified. Halmos and Forge symbolic runs are bounded proofs.
7. **Channel3 is a third party's testimony**, not a cryptographic proof. TLSNotary is one, but it
   is alpha software.
8. **TEE.fail exists.** That is why there are two vendors and a veto window.
9. **ERC-8004 and the selective-disclosure specifications are drafts.** Versions are pinned.
10. **A passkey is consent, not a standard payment signature.** The standard signature is the
    attested TEE's.
11. **Secure Payment Confirmation exists only in Chromium browsers.** Elsewhere the approval uses a
    plain WebAuthn assertion.
12. **Two flows, kept apart.** The sandbox flow, with our own store as the merchant, has attacks,
    disputes and slashes. The live flow makes small real purchases at real stores, with no attacks
    and no disputes. Keelson covers no live purchase.

## Accepted risks

Component-level accepted risks are listed where they apply:

- TEE legs: [engine/tee, Security](../engine/tee/README.md#security)
- Contracts: [assumptions and accepted findings](../contracts/README.md#assumptions-and-what-is-not-covered), and the contracts are unaudited
- Log key handling: [engine/tee, Sign the log's checkpoints](../engine/tee/README.md#sign-the-logs-checkpoints)
- Monitor: it does not yet check TEE signatures of leaves or on-chain anchors, and says so in `/report`

To report a vulnerability, see [contracts/SECURITY.md](../contracts/SECURITY.md).
