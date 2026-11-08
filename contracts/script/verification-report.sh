#!/usr/bin/env bash
# Rewrites the README's verification table between `<!-- verification:start -->` and `<!-- verification:end -->` from the
# results of a contracts-verify run: certora-*.json ({"rules": {name: status}}), halmos.json, forge-symbolic.json,
# invariant.json and mutation-*.json, all in one directory. A cell shows ✅ only when every listed rule or check
# passed in those results.
#
#   script/verification-report.sh <results dir> [README.md]
set -euo pipefail
cd "$(dirname "$0")/.."

dir=${1:?results directory}
readme=${2:-README.md}

shopt -s nullglob
certora=$(jq -s 'map(.rules) | add // {}' "$dir"/certora-*.json /dev/null)
halmos=$(jq '[.test_results[][] | {(.name | sub("\\(.*"; "")): (.exitcode == 0)}] | add // {}' "$dir/halmos.json" 2>/dev/null || echo '{}')
forge_symbolic=$(jq '[.[].test_results | to_entries[] | {(.key | sub("\\(.*"; "")): (.value.status == "Success")}] | add // {}' \
  "$dir/forge-symbolic.json" 2>/dev/null || echo '{}')
invariant=$(jq '[.[].test_results | to_entries[] | {(.key | sub("\\(.*"; "")): (.value.status == "Success")}] | add // {}' \
  "$dir/invariant.json" 2>/dev/null || echo '{}')

# ✅ when every name passed, ❌ when one failed, ⏳ when one has no result; names in backticks.
cell() {
  local names=$1 results=$2 suffix=${3:-}
  [[ "$names" == "-" ]] && { echo "—"; return; }
  jq -rn --arg names "$names" --argjson r "$results" --arg suffix "$suffix" '
    ($names | split(",")) as $n
    | ($n | map(sub("@.*"; "")) | map($r[.])) as $s
    | (if all($s[]; . == true or . == "VERIFIED") then "✅"
       elif any($s[]; . == null) then "⏳" else "❌" end)
      + " " + ($n | map("`" + . + "`") | join(", ")) + $suffix'
}

{
  echo "<!-- verification:start -->"
  echo "| Id | Property | Proven (Certora, unbounded) | Bounded (Halmos; forge \`--symbolic\`) | Fuzzed (fork, real PYUSD) |"
  echo "|---|---|---|---|---|"
  while IFS=$'\t' read -r id property rules checks fuzz; do
    [[ "$id" == \#* || -z "$id" ]] && continue
    bounded="—"
    if [[ "$checks" != "-" ]]; then
      bounded=$(cell "$checks" "$(jq -n --argjson h "$halmos" --argjson f "$forge_symbolic" \
        '$h * ($f | with_entries(select(.value)))')")
    fi
    fuzzed=$(cell "$fuzz" "$invariant" "$([[ $fuzz != - ]] && echo " (256 × 100; Medusa)")")
    echo "| $id | $property | $(cell "$rules" "$certora") | $bounded | $fuzzed |"
  done < verification/properties.tsv
  echo
  echo "| Mutation (\`forge test --mutate\`) | Score | Killed | Survived | Invalid | Timed out |"
  echo "|---|---|---|---|---|---|"
  for f in "$dir"/mutation-*.json; do
    name=$(basename "$f" .json)
    jq -r --arg n "${name#mutation-}" '.summary | "| `\($n)` | \(.mutation_score)% | \(.killed) | \(.survived) | \(.invalid) | \(.timed_out) |"' "$f"
  done
  echo "<!-- verification:end -->"
} > "$dir/verification.md"

awk -v table="$dir/verification.md" '
  /<!-- verification:start -->/ { while ((getline line < table) > 0) print line; skip = 1; next }
  /<!-- verification:end -->/ { skip = 0; next }
  !skip { print }
' "$readme" > "$readme.tmp"
mv "$readme.tmp" "$readme"
