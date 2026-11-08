#!/usr/bin/env bash
# Fails when Aderyn reports a high finding that verification/aderyn-accepted.json does not list by detector and
# location. The sources are deployed and immutable, so accepted findings are listed here rather than annotated in them.
#
#   script/aderyn-gate.sh aderyn.json verification/aderyn-accepted.json
set -euo pipefail

report=${1:?report}
accepted=${2:?accepted list}

open=$(jq -r --slurpfile ok "$accepted" '
  [$ok[0][] | "\(.detector) \(.location)"] as $keys
  | .high_issues.issues[] | .detector_name as $d | .instances[]
  | "\($d) \(.contract_path):\(.line_no)"
  | select(. as $k | $keys | index($k) | not)' "$report")

if [[ -n "$open" ]]; then
  echo "Aderyn high findings not accepted:" >&2
  echo "$open" >&2
  exit 1
fi
echo "Aderyn: $(jq '[.high_issues.issues[].instances[]] | length' "$report") high instances, all accepted."
