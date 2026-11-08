#!/usr/bin/env bash
# Fetches the output.json of the Prover job certoraRun last submitted and writes {"rules": {rule: status}}, where a
# parametric rule is VERIFIED only when no method failed.
#
#   CERTORAKEY=... script/certora-results.sh certora-<conf>.json
set -euo pipefail
cd "$(dirname "$0")/.."

out=${1:?output file}
zip=$(head -1 .certora_internal/.zip-output-url.txt)
curl -fsS -H "Authorization: Bearer $CERTORAKEY" "${zip%/f/outputs}/f/output.json" | jq '{rules: (.rules | with_entries(
  select(.key != "envfreeFuncsStaticCheck")
  | .value |= (if type == "string" then (if . == "SUCCESS" then "VERIFIED" else . end)
               else (if (keys - ["SUCCESS"]) == [] then "VERIFIED" else (keys - ["SUCCESS"] | join("/")) end) end)))}' > "$out"
jq -r '.rules | to_entries[] | "\(.value)\t\(.key)"' "$out"
