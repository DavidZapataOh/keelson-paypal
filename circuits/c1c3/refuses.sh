#!/usr/bin/env bash
# After prove.sh: proves the composition again with C3's key in C1's slot, and with C1's proof
# under another C_m, and fails unless bb's verifier rejects both proofs. Needs nargo, bb and jq.
set -euo pipefail
cd "$(dirname "$0")"
c3_vk=$(grep '^c3_vk = ' Prover.toml | cut -d' ' -f3-)
sed "s/^c1_vk = .*/c1_vk = ${c3_vk}/" Prover.toml >Prover_swapped.toml
# The first C1 input is C_m: one changed hex digit is another mandate's.
sed -E 's/^(c1_inputs = \["0x.{63})(.)/\1f/' Prover.toml >Prover_other.toml
for case in swapped other; do
  nargo execute --silence-warnings --prover-name "Prover_$case" "$case"
  bb prove -b target/anonymous_purchase.json -w "target/$case.gz" -k anonymous_purchase.vk -o "target/$case" -t evm || continue
  if bb verify -k anonymous_purchase.vk -p "target/$case/proof" -i "target/$case/public_inputs" -t evm; then
    echo "the $case composition verified" >&2
    exit 1
  fi
done
