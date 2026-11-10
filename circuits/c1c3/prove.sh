#!/usr/bin/env bash
# Proves C1 (circuits/c1/Prover_anonymous.toml) and C3 (circuits/c3/Prover_payment.toml) for
# recursion, composes them, and writes the composed proof as `{ proof, publicInputs }` JSON to $1,
# the calldata of `verify(bytes,bytes32[])`. Run the three build.sh first. Needs nargo, bb and jq.
set -euo pipefail
out=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
cd "$(dirname "$0")"
inner() { # $1 circuit dir, $2 package, $3 prover name
  (cd "../$1" && nargo execute --silence-warnings --prover-name "$3" "$3" &&
    bb write_vk -b "target/$2.json" -o "target/$3-recursive" -t noir-recursive &&
    bb prove -b "target/$2.json" -w "target/$3.gz" -k "target/$3-recursive/vk" \
      -o "target/$3-recursive" -t noir-recursive --output_format json)
}
inner c1 mandate_predicate Prover_anonymous
inner c3 anonymous_mandate Prover_payment
zk=../../services/api/zk
c1=../c1/target/Prover_anonymous-recursive
c3=../c3/target/Prover_payment-recursive
q='map("\"" + . + "\"") | join(", ") | "[" + . + "]"'
{
  echo "c1_inputs = $(jq -r ".public_inputs | $q" "$c1/public_inputs.json")"
  echo "mandate_hash = $(jq -r '.public_inputs[1] | "\"" + . + "\""' "$c3/public_inputs.json")"
  echo "user_set_root = $(jq -r '.public_inputs[2] | "\"" + . + "\""' "$c3/public_inputs.json")"
  echo "c1_vk = $(jq -r ".vk | $q" "$zk/mandate_predicate.recursive.json")"
  echo "c1_proof = $(jq -r ".proof | $q" "$c1/proof.json")"
  echo "c3_vk = $(jq -r ".vk | $q" "$zk/anonymous_mandate.recursive.json")"
  echo "c3_proof = $(jq -r ".proof | $q" "$c3/proof.json")"
} >Prover.toml
nargo execute --silence-warnings
bb prove -b target/anonymous_purchase.json -w target/anonymous_purchase.gz -k anonymous_purchase.vk -o target -t evm
bb verify -k anonymous_purchase.vk -p target/proof -i target/public_inputs -t evm
jq -n \
  --arg proof "0x$(xxd -p -c0 target/proof)" \
  --arg inputs "$(xxd -p -c32 target/public_inputs)" \
  '{proof: $proof, publicInputs: ($inputs | split("\n") | map(select(length > 0) | "0x" + .))}' >"$out"
