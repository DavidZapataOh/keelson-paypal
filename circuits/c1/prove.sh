#!/usr/bin/env bash
# Proves Prover.toml with bb and writes the proof as `{ proof, publicInputs }` JSON to $1, the
# calldata of `verify(bytes,bytes32[])`. Run build.sh first. Needs nargo, bb and jq on PATH.
set -euo pipefail
out=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
cd "$(dirname "$0")"
nargo execute --silence-warnings
bb prove -b target/mandate_predicate.json -w target/mandate_predicate.gz \
  -k ../../engine/tee/zk/mandate_predicate.vk -o target -t evm
bb verify -k ../../engine/tee/zk/mandate_predicate.vk -p target/proof -i target/public_inputs -t evm
jq -n \
  --arg proof "0x$(xxd -p -c0 target/proof)" \
  --arg inputs "$(xxd -p -c32 target/public_inputs)" \
  '{proof: $proof, publicInputs: ($inputs | split("\n") | map(select(length > 0) | "0x" + .))}' >"$out"
