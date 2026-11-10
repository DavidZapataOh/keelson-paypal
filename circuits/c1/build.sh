#!/usr/bin/env bash
# Compiles the circuit and writes what the engine, the verifier and the contracts pin: the ACIR
# program, its verification key and the Solidity verifiers. Needs nargo and bb on PATH.
set -euo pipefail
cd "$(dirname "$0")"
out=../../engine/tee/zk
verifiers=../../contracts/src/verifiers

nargo compile --silence-warnings
# Debug symbols and the file map carry local paths: the engine needs the program and its ABI only.
jq -c '{noir_version, hash, abi, bytecode}' target/mandate_predicate.json >"$out/mandate_predicate.json"
bb write_vk -b target/mandate_predicate.json -o target -t evm
cp target/vk "$out/mandate_predicate.vk"
mkdir -p "$verifiers"
bb write_solidity_verifier -k target/vk -t evm --optimized -o "$verifiers/MandatePredicateVerifier.sol"
bb write_solidity_verifier -k target/vk -t evm -o "$verifiers/MandatePredicateReferenceVerifier.sol"
