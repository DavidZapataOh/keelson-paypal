# keelson-policy

The Cedar schema and policy set, the fail-closed evaluator, and the symcc proofs that the policy set states the mandate rules in `policy/spec.cedar`. It also holds the dispute attribution table and the `Verdict` message built from it.

## Proofs

The proofs need [cvc5 1.3.1](https://github.com/cvc5/cvc5/releases/tag/cvc5-1.3.1), the solver `cedar-policy-symcc` 0.8.1 is verified against. Put it on `PATH` or point `CVC5` at it, and check the release asset before using it:

| Asset                          | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `cvc5-macOS-arm64-static.zip`  | `a0e7f5b03b1bc4284fbfff7cdfb08c704801701cf7ece83a13f8a505e7581215` |
| `cvc5-Linux-x86_64-static.zip` | `1a1cda20d2df4938fa4944a69f33ddc9172e319ece0eed0aa09c4d7abede3ed1` |

```sh
cargo test -p keelson-policy
cargo run -p keelson-policy --bin prove -- --out engine/policy/proofs/proof-bundle.json
cargo run -p keelson-policy --bin prove -- --seed-bug overflow
cargo run -p keelson-policy --bin prove -- --seed-bug extra-permit
```

`proofs/proof-bundle.json` is committed, and CI checks that it is fresh. `PROOF_BUNDLE_HASH` is `sha256:` + hex(SHA-256(JCS(bundle))), computed at build time. On `main`, CI attests the bundle's build provenance, which `gh attestation verify engine/policy/proofs/proof-bundle.json -R <owner>/<repo>` checks.

## Dispute attribution

`RULES` is the ordered decision list that names who pays for a PayPal dispute: the operator (its bond is slashed), Keelson (the warranty reserve pays), the merchant or the user. It is compiled to one Cedar policy set per party, under `policy/attribution.cedarschema`, whose `Reason` enum holds PayPal's `dispute_reason` values. Each rule is a `permit` guarded by the negation of every earlier rule, so the first rule that matches decides.

| Rule | Condition (and no earlier rule)                                                           | Liable   |
| ---- | ----------------------------------------------------------------------------------------- | -------- |
| R00  | a proof (mandate, countersignature, log inclusion, attestation) does not verify           | operator |
| R10  | `MERCHANDISE_OR_SERVICE_NOT_RECEIVED` and tracking shows delivery                         | user     |
| R11  | `MERCHANDISE_OR_SERVICE_NOT_RECEIVED`                                                     | merchant |
| R20  | `CREDIT_NOT_PROCESSED` and a refund is recorded                                           | user     |
| R21  | `CREDIT_NOT_PROCESSED`                                                                    | merchant |
| R30  | `DUPLICATE_TRANSACTION` and Keelson countersigned a single-use mandate twice              | Keelson  |
| R31  | `DUPLICATE_TRANSACTION` and more than one capture under one countersignature              | operator |
| R32  | `DUPLICATE_TRANSACTION`                                                                   | user     |
| R35  | `PAYMENT_BY_OTHER_MEANS`, `CANCELED_RECURRING_BILLING` or `PROBLEM_WITH_REMITTANCE`       | merchant |
| R40  | `INCORRECT_AMOUNT` and the capture differs from the countersigned total                   | merchant |
| R50  | `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED` and the item differs from the attested snapshot | merchant |
| R60  | a green field failed                                                                      | Keelson  |
| R61  | an amber field failed                                                                     | operator |
| R62  | a gray field failed                                                                       | user     |
| R70  | no field failed                                                                           | user     |

`attribute` evaluates the four sets and fails closed unless exactly one rule fires. `verdict` turns the result into the `Verdict` EIP-712 message: `liable` is 1 operator, 2 Keelson, 3 merchant or 4 user (the vault slashes only on 1 and the reserve pays only on 2), `disputeId` is `keccak256(paypalDisputeId ‖ coverageId)`, `inputsHash` is `H("keelson/verdict/v1", JCS({attribution_policy_set_hash, facts}))`, binding the facts to the rules that judged them, and `policySetHash` is the mandate policy set's hash, as in the countersignature. When a green and an amber field both fail, R60 comes first: Keelson pays and the operator is not slashed.

symcc proves on the generated sets that the table is total (every dispute has a liable party) and exclusive (never two), that Keelson is liable only with valid proofs, that the operator is liable only for a missing proof, a duplicate capture or a failed amber field, that an `UNAUTHORISED` dispute with valid proofs and no failed field is the user's, and that every rule is reachable. The results are in `proofs/attribution-bundle.json`, also checked for freshness and attested on `main`.

```sh
cargo run -p keelson-policy --bin prove -- --attribution --out engine/policy/proofs/attribution-bundle.json
cargo run -p keelson-policy --bin prove -- --seed-bug no-precedence   # rules without precedence: two parties liable
cargo run -p keelson-policy --bin prove -- --seed-bug drop-gray       # R62 removed: a dispute with no liable party
cargo bench -p keelson-policy --bench attribute
```
