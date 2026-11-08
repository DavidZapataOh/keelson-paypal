# @keelson/core

Canonical JSON (RFC 8785), domain-separated hashing, Poseidon2, EIP-712, money and ULID primitives, and the Channel3 observation document with its field-by-field comparison, so a verifier can re-run it in the browser. Poseidon2 and EIP-712 live in the `@keelson/core/poseidon2` and `@keelson/core/eip712` subpaths, so importing the root does not load bb.js or viem. `keelson-core` in `engine/core` mirrors them, and the vectors in `test/vectors` pin both: `pnpm vectors` regenerates them from this package, and `cargo test -p keelson-core` checks them.

## TypeScript and Rust names

Names differ only where each language's conventions do (`camelCase` here, `snake_case` in Rust), except for these:

| TypeScript                               | Rust                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `DST.mandate`, `DST.mandateChallenge`, … | `Dst::Mandate`, `Dst::MandateChallenge`, …                                |
| `keelsonDomain(chainId, contract)`       | `eip712::domain(chain_id, contract)`                                      |
| `hashKeelson(type, message, domain)`     | `alloy_sol_types::SolStruct::eip712_signing_hash` on the `eip712` structs |
| `poseidon2(inputs)` is `async`           | `poseidon2(&inputs)` is synchronous                                       |
| `Money.minor` is a `bigint`              | `Money.minor` is an `i128`                                                |
