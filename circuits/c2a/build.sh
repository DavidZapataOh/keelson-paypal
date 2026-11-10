#!/usr/bin/env bash
# Compiles the circuit and writes what the contracts pin: the verification key and the Solidity
# verifiers. Needs nargo and bb on PATH.
set -euo pipefail
cd "$(dirname "$0")"
verifiers=../../contracts/src/verifiers

nargo compile --silence-warnings
bb write_vk -b target/mandate_violation.json -o target -t evm
cp target/vk mandate_violation.vk
bb write_solidity_verifier -k target/vk -t evm --optimized -o "$verifiers/MandateViolationVerifier.sol"
bb write_solidity_verifier -k target/vk -t evm -o "$verifiers/MandateViolationReferenceVerifier.sol"
