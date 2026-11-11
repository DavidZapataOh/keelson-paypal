# Engine proof (SP1)

The engine's canonicalizer and Cedar evaluation, run again in the [SP1](https://docs.succinct.xyz/docs/sp1/introduction) zkVM for disputes. The program reads a countersign's stored inputs (`keelson_policy::CountersignInput`: the registered mandate, the cart, the PayPal unit, the evidence sources, leg A's clock and budget, and the signed fields the evaluation does not decide), calls `keelson_policy::recompute`, the same code the TEE legs sign with, and commits `abi.encode(evalHash, countersignDigest)`.

A Groth16 proof of it is verified on chain by `EngineProofVerifier` through Succinct's SP1 verifier gateway. When it verifies, the engine build the trace names, run over those inputs, gives the `evalHash` both legs signed, independently of the TEEs. A PayPal deny is decided before the evaluation and has no proof.

```sh
sp1up -v v6.10.0
cargo build --release -p keelson-engine-proof
./target/release/keelson-engine-proof vkey
./target/release/keelson-engine-proof execute input.json        # cycles, evalHash, digest
SP1_PROVER=cpu ./target/release/keelson-engine-proof prove input.json proof.json
NETWORK_PRIVATE_KEY=... ENGINE_PROOF_MAX_COST=2000000000000000000 \
  ./target/release/keelson-engine-proof request input.json   # {"request_id": ...}
NETWORK_PRIVATE_KEY=... ./target/release/keelson-engine-proof wait input.json <request-id> proof.json
```

Every command recomputes the countersign natively first and stops unless the zkVM commits the same values. A CPU proof peaks at about 45 GB of memory and takes over half an hour on eight cores, so disputes are proven on the [Succinct Prover Network](https://docs.succinct.xyz/docs/sp1/prover-network/quickstart). `request` bids the network's suggested price per prover gas unit plus 20%, with the gas limit the local simulation measures, and is refused unless the Groth16 base fee plus that limit at that price fits under `ENGINE_PROOF_MAX_COST` (PROVE wei). It prints the request's id as soon as the network takes it, then cancels the request, while it is still in its auction, if the base fee it was signed with is missing or over the cap. `wait` waits for a request, verifies its proof locally and writes it, with the request, gas used and cost in its `network` field; a caller that keeps the id can always wait again instead of paying for a second request. The `engine-proof` workflow builds the program, executes `engine/tee/tests/vectors/countersign-allow.json` on every change and publishes the prover; the `proveEngine` workflow task downloads it to prove disputes.

The prover runs the program with SP1's portable executor (the SDK's `profiling` feature): the native one keeps the guest's memory in `/dev/shm`, which the 64 MB a hosted container mounts there cannot hold. The program, and its verifying key, are the same either way.

The program is built in SP1's `v6.10.0` Docker image, so every build gives the same ELF and verifying key; a build outside it can differ from one run to the next. The workspace's lockfile was seeded from the engine's, so the program links the crate versions the TEE build does. `stacker`, Cedar's stack probe, is replaced by a no-op: it maps memory through an operating system the zkVM does not have, and Cedar evaluates the same without it. A change to the program changes its verifying key, which needs a new `EngineProofVerifier`.
