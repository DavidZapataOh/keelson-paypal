# Engine proof (SP1)

The engine's canonicalizer and Cedar evaluation, run again in the [SP1](https://docs.succinct.xyz/docs/sp1/introduction) zkVM for disputes. The program reads a countersign's stored inputs (`keelson_policy::CountersignInput`: the registered mandate, the cart, the PayPal unit, the evidence sources, leg A's clock and budget, and the signed fields the evaluation does not decide), calls `keelson_policy::recompute`, the same code the TEE legs sign with, and commits `abi.encode(evalHash, countersignDigest)`.

A Groth16 proof of it is verified on chain by `EngineProofVerifier` through Succinct's SP1 verifier gateway. When it verifies, the engine build the trace names, run over those inputs, gives the `evalHash` both legs signed, independently of the TEEs. A PayPal deny is decided before the evaluation and has no proof.

```sh
sp1up -v v6.10.0
cargo build --release -p keelson-engine-proof
./target/release/keelson-engine-proof vkey
./target/release/keelson-engine-proof execute input.json        # cycles, evalHash, digest
SP1_PROVER=cpu ./target/release/keelson-engine-proof prove input.json proof.json
SP1_PROVER=network NETWORK_PRIVATE_KEY=... ENGINE_PROOF_MAX_COST=2000000000000000000 \
  ./target/release/keelson-engine-proof prove input.json proof.json
```

Both commands recompute the countersign natively first and stop unless the zkVM commits the same values. A CPU proof peaks at about 45 GB of memory and takes over half an hour on eight cores, so disputes are proven on the [Succinct Prover Network](https://docs.succinct.xyz/docs/sp1/prover-network/quickstart) (`SP1_PROVER=network`). The request bids the network's suggested price per prover gas unit plus 20%, with the gas limit the local simulation measures, and is refused unless the Groth16 base fee plus that limit at that price fits under `ENGINE_PROOF_MAX_COST` (PROVE wei). The returned proof is verified locally before it is written; its request, gas used and cost are in the output's `network` field. The `engine-proof` workflow builds the program, executes `engine/tee/tests/vectors/countersign-allow.json` on every change and publishes the prover; the `proveEngine` workflow task downloads it to prove disputes.

The workspace's lockfile was seeded from the engine's, so the program links the crate versions the TEE build does. `stacker`, Cedar's stack probe, is replaced by a no-op: it maps memory through an operating system the zkVM does not have, and Cedar evaluates the same without it. A change to the program changes its verifying key, which needs a new `EngineProofVerifier`.
