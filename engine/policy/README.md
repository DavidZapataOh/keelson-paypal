# keelson-policy

The Cedar schema and policy set, the fail-closed evaluator, and the symcc proofs that the policy set states the mandate rules in `policy/spec.cedar`.

## Proofs

The proofs need [cvc5 1.3.1](https://github.com/cvc5/cvc5/releases/tag/cvc5-1.3.1), the solver `cedar-policy-symcc` 0.8.1 is verified against. Put it on `PATH` or point `CVC5` at it, and check the release asset before using it:

| Asset | SHA-256 |
|---|---|
| `cvc5-macOS-arm64-static.zip` | `a0e7f5b03b1bc4284fbfff7cdfb08c704801701cf7ece83a13f8a505e7581215` |
| `cvc5-Linux-x86_64-static.zip` | `1a1cda20d2df4938fa4944a69f33ddc9172e319ece0eed0aa09c4d7abede3ed1` |

```sh
cargo test -p keelson-policy
cargo run -p keelson-policy --bin prove -- --out engine/policy/proofs/proof-bundle.json
cargo run -p keelson-policy --bin prove -- --seed-bug overflow
cargo run -p keelson-policy --bin prove -- --seed-bug extra-permit
```

`proofs/proof-bundle.json` is committed, and CI checks that it is fresh. `PROOF_BUNDLE_HASH` is `sha256:` + hex(SHA-256(JCS(bundle))), computed at build time. On `main`, CI attests the bundle's build provenance, which `gh attestation verify engine/policy/proofs/proof-bundle.json -R <owner>/<repo>` checks.
