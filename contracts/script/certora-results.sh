#!/usr/bin/env bash
# Fetches the output.json of the Prover job certoraRun last submitted (or of the job id given) and writes
# {"rules": {rule: status}}: VERIFIED when no method or induction step anywhere in the rule failed, timed out or is
# unknown, else the first such status.
#
#   CERTORAKEY=... script/certora-results.sh certora-<conf>.json [job id]
set -euo pipefail
cd "$(dirname "$0")/.."

out=${1:?output file}
if [[ -n "${2:-}" ]]; then
  url="https://data-api.certora.com/v1/domain/jobs/$2/f/output.json"
else
  zip=$(head -1 .certora_internal/.zip-output-url.txt)
  url="${zip%/f/outputs}/f/output.json"
fi
curl -fsSL -H "Authorization: Bearer $CERTORAKEY" "$url" | gzip -dcf | jq '
  def status:
    if type == "string" then .
    elif type == "object" then
      [to_entries[] | if (.key | test("^(SUCCESS|FAIL|TIMEOUT|UNKNOWN|SANITY_FAIL)$"))
        then (if (.value | length) > 0 then .key else "SUCCESS" end) else (.value | status) end]
      | (map(select(. != "SUCCESS")) | if length == 0 then "SUCCESS" else .[0] end)
    else "SUCCESS" end;
  {rules: (.rules | del(.envfreeFuncsStaticCheck) | map_values(status | if . == "SUCCESS" then "VERIFIED" else . end))}' > "$out"
jq -r '.rules | to_entries[] | "\(.value)\t\(.key)"' "$out"
