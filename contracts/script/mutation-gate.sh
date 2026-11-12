#!/usr/bin/env bash
# Fails when the mutation score is below the budget, or when a surviving mutant is not proven equivalent in
# verification/survivors.md (one line per survivor: - `file:line:column original -> mutant`: proof).
#
#   script/mutation-gate.sh mutation.json [budget]
set -euo pipefail

report=${1:?mutation.json}
budget=${2:-90}
survivors=verification/survivors.md

jq -e --argjson budget "$budget" '.summary.mutation_score >= $budget' "$report" >/dev/null || {
  echo "Mutation score $(jq '.summary.mutation_score' "$report") is below $budget." >&2
  exit 1
}

unexplained=$(jq -r '.survived_mutants | to_entries[] | .key as $f | .value[]
  | "\($f):\(.line):\(.column) \(.original) -> \(.mutant)"' "$report" | while IFS= read -r mutant; do
  grep -F -- "- \`$mutant\`: " "$survivors" | grep -qE '`: [^[:space:]]' || echo "$mutant"
done)

if [[ -n "$unexplained" ]]; then
  echo "Surviving mutants without an equivalence proof in $survivors:" >&2
  echo "$unexplained" >&2
  exit 1
fi
jq -r '.summary | "Mutation score \(.mutation_score)%: \(.killed) killed, \(.survived) survived (all explained), \(.invalid) invalid, \(.skipped) skipped, \(.timed_out) timed out."' "$report"
