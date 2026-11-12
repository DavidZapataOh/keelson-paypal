#!/usr/bin/env bash
# Times `bb prove` of each circuit's demo witness five times, drops the first run, and fails
# when the median exceeds the circuit's prove_ms budget in budgets.json for $MACHINE (default
# ci: GitHub's ubuntu-24.04, 4 vCPU). Run after each circuit's prove.sh. Needs bb and jq.
set -euo pipefail
cd "$(dirname "$0")"
machine=${MACHINE:-ci}
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

status=0
echo "| Circuit | Prove p50 (ms) | Budget (ms) | Runs (ms) |"
echo "|---|---|---|---|"
for c in $(jq -r 'keys_unsorted[]' budgets.json); do
  artifact=$(jq -r ".$c.artifact" budgets.json)
  witness=$(jq -r ".$c.witness" budgets.json)
  vk=$(jq -r ".$c.vk" budgets.json)
  budget=$(jq ".$c.prove_ms.$machine" budgets.json)
  runs=()
  for i in 0 1 2 3 4; do
    start=$(date +%s%N)
    bb prove -b "$c/target/$artifact.json" -w "$c/target/$witness.gz" -k "$vk" -o "$out" -t evm \
      >/dev/null 2>&1
    if ((i > 0)); then
      runs+=($((($(date +%s%N) - start) / 1000000)))
    fi
  done
  read -r -a sorted <<<"$(printf '%s\n' "${runs[@]}" | sort -n | tr '\n' ' ')"
  p50=$(((sorted[1] + sorted[2]) / 2))
  echo "| $c | $p50 | $budget | ${runs[*]} |"
  if ((p50 > budget)); then
    echo "$c: proving p50 $p50 ms > budget $budget ms on $machine" >&2
    status=1
  fi
done
exit "$status"
