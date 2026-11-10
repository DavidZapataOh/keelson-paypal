#!/usr/bin/env bash
# Proves Prover_$1.toml with bb and writes the proof as `{ proof, publicInputs }` JSON to $2, the
# calldata of `verify(bytes,bytes32[])`. Run build.sh first. Needs nargo, bb and jq on PATH.
set -euo pipefail
out=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
cd "$(dirname "$0")"
nargo execute --silence-warnings --prover-name "Prover_$1" "$1"
bb prove -b target/mandate_violation.json -w "target/$1.gz" -k mandate_violation.vk -o "target/$1" -t evm
bb verify -k mandate_violation.vk -p "target/$1/proof" -i "target/$1/public_inputs" -t evm
jq -n \
  --arg proof "0x$(xxd -p -c0 "target/$1/proof")" \
  --arg inputs "$(xxd -p -c32 "target/$1/public_inputs")" \
  '{proof: $proof, publicInputs: ($inputs | split("\n") | map(select(length > 0) | "0x" + .))}' >"$out"
