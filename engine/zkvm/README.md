# Engine proof (SP1)

The engine's canonicalizer and Cedar evaluation, run again in the [SP1](https://docs.succinct.xyz/docs/sp1/introduction) zkVM for disputes. The program reads a countersign's stored inputs (`keelson_policy::CountersignInput`: the registered mandate, the cart, the PayPal unit, the evidence sources, leg A's clock and budget, and the signed fields the evaluation does not decide), calls `keelson_policy::recompute`, the same code the TEE legs sign with, and commits `abi.encode(evalHash, countersignDigest)`.

A Groth16 proof of it is verified on chain by `EngineProofVerifier` through Succinct's SP1 verifier gateway. When it verifies, the engine build the trace names, run over those inputs, gives the `evalHash` both legs signed, independently of the TEEs. A PayPal deny is decided before the evaluation and has no proof.

```sh
# The SP1 toolchain, and a RISC-V C compiler as CC_riscv64im_succinct_zkvm_elf (sp1up --c-toolchain,
# or riscv64-unknown-elf-gcc): Cedar's stack probe assembles a RISC-V source.
sp1up -v v6.10.0
cargo build --release -p keelson-engine-proof
./target/release/keelson-engine-proof vkey
./target/release/keelson-engine-proof execute input.json        # cycles, evalHash, digest
SP1_PROVER=cpu ./target/release/keelson-engine-proof prove input.json proof.json
```

Both commands recompute the countersign natively first and stop unless the zkVM commits the same values. The Groth16 wrap needs about 14 GB of memory. The `engine-proof` workflow builds the program, executes `engine/tee/tests/vectors/countersign-allow.json` on every change and publishes the prover; disputes are proven on the `proveEngine` workflow task.

The workspace's lockfile was seeded from the engine's, so the program links the crate versions the TEE build does. A change to the program changes its verifying key, which needs a new `EngineProofVerifier`.
