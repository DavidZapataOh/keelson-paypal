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
# The latest Prover results are pinned in verification/certora/; a run's own results replace them.
# `rule@Conf` names one conf's result; a bare rule takes the first conf, in file order, that has it.
certora=$(for f in verification/certora/certora-*.json "$dir"/certora-*.json; do
  jq --arg conf "$(basename "$f" .json | sed 's/^certora-//')" '.rules | . + with_entries(.key += "@" + $conf)' "$f"
done | jq -s 'reduce .[] as $r ({}; . + ($r | with_entries(select(.key | contains("@")))) | ($r | with_entries(select(.key | contains("@") | not))) + .)')
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
    | ($n | map(., (sub("@"; "Reachable@") | if contains("Reachable") then . else . + "Reachable" end))
       | map(select(. as $k | $r | has($k) or ($k | contains("Reachable") | not))) | map($r[.])) as $s
    | (if all($s[]; . == true or . == "VERIFIED" or . == "CAUGHT") then "✅"
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
      # A check run by both engines passes only if both pass.
      bounded=$(cell "$checks" "$(jq -n --argjson h "$halmos" --argjson f "$forge_symbolic" \
        '[($h | keys) + ($f | keys) | unique[] as $k
          | {($k): (if ($h | has($k)) and ($f | has($k)) then $h[$k] and $f[$k] elif ($h | has($k)) then $h[$k] else $f[$k] end)}]
          | add // {}')")
    fi
    fuzzed=$(cell "$fuzz" "$invariant" "$([[ $fuzz != - ]] && echo " (256 × 100)")")
    echo "| $id | $property | $(cell "$rules" "$certora") | $bounded | $fuzzed |"
  done < verification/properties.tsv
  echo
  # Killed, invalid and timed-out counts vary with the worker count; the score and the survivors do not.
  echo "| Mutation (\`forge test --mutate\`) | Score | Survived |"
  echo "|---|---|---|"
  for f in "$dir"/mutation-*.json; do
    name=$(basename "$f" .json)
    jq -r --arg n "${name#mutation-}" '.summary | "| `\($n)` | \(.mutation_score)% | \(.survived) |"' "$f"
  done
  echo "<!-- verification:end -->"
} > "$dir/verification.md"

awk -v table="$dir/verification.md" '
  /<!-- verification:start -->/ { while ((getline line < table) > 0) print line; skip = 1; next }
  /<!-- verification:end -->/ { skip = 0; next }
  !skip { print }
' "$readme" > "$readme.tmp"
mv "$readme.tmp" "$readme"
