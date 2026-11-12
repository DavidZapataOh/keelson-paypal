#!/usr/bin/env bash
# Compares each circuit's gate and ACIR opcode counts from `bb gates` with budgets.json. Fails on
# any count above its budget; a count below it passes and asks for the budget to be lowered.
# Run after each circuit's build.sh. Needs bb and jq on PATH.
set -euo pipefail
cd "$(dirname "$0")"

commas() {
  local n=$1 out=""
  while ((${#n} > 3)); do
    out=",${n: -3}$out"
    n=${n:0:${#n}-3}
  done
  echo "$n$out"
}

status=0
rows=""
for c in $(jq -r 'keys_unsorted[]' budgets.json); do
  artifact=$(jq -r ".$c.artifact" budgets.json)
  counts=$(bb gates -b "$c/target/$artifact.json" 2>/dev/null | jq -c '.functions[0]')
  for metric in gates acir_opcodes; do
    field=$([ "$metric" = gates ] && echo circuit_size || echo acir_opcodes)
    got=$(jq ".$field" <<<"$counts")
    budget=$(jq ".$c.$metric" budgets.json)
    label=${metric/acir_opcodes/ACIR opcodes}
    if ((got > budget)); then
      echo "$c: $(commas "$got") $label > budget $(commas "$budget")" >&2
      status=1
    elif ((got < budget)); then
      echo "$c: $(commas "$got") $label < budget $(commas "$budget"): lower the budget"
    fi
  done
  rows+="| $c | $(commas "$(jq .circuit_size <<<"$counts")") | $(commas "$(jq ".$c.gates" budgets.json)") | $(commas "$(jq .acir_opcodes <<<"$counts")") |"$'\n'
done

table="| Circuit | Gates | Budget | ACIR opcodes |"$'\n'"|---|---|---|---|"$'\n'"$rows"
echo "$table"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "$table" >>"$GITHUB_STEP_SUMMARY"
fi
exit "$status"
