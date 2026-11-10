#!/usr/bin/env bash
# Compiles the circuit and writes what the contracts pin: the verification key and the Solidity
# verifiers. Needs nargo and bb on PATH.
set -euo pipefail
cd "$(dirname "$0")"
verifiers=../../contracts/src/verifiers

nargo compile --silence-warnings
bb write_vk -b target/amber_contradiction.json -o target -t evm
cp target/vk amber_contradiction.vk
bb write_solidity_verifier -k target/vk -t evm --optimized -o "$verifiers/AmberContradictionVerifier.sol"
bb write_solidity_verifier -k target/vk -t evm -o "$verifiers/AmberContradictionReferenceVerifier.sol"
