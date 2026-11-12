#!/usr/bin/env bash
# Fails when a job reads a deploy credential without running in a GitHub environment.
# Environments limit these secrets to main and, for deploys, to an approved run.
set -euo pipefail

secrets='PHALA_CLOUD_API_KEY|KEELSON_TEE_TOKEN|KEELSON_TEE_TOKEN_SHA256|RENDER_API_KEY|RAILWAY_TOKEN_MONITOR|RAILWAY_TOKEN_WITNESS|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_REGION'
status=0
for wf in .github/workflows/*.yml; do
  # A job that calls a reusable workflow cannot name an environment; the called workflow's jobs are checked.
  for job in $(yq -r '.jobs | to_entries | .[] | select(.value.uses == null) | .key' "$wf"); do
    if yq -o=json ".jobs.\"$job\"" "$wf" | grep -Eq "secrets\.($secrets)\b" &&
      [ "$(yq -r ".jobs.\"$job\".environment // \"\"" "$wf")" = "" ]; then
      echo "$(basename "$wf"):$job reads a deploy secret outside an environment"
      status=1
    fi
  done
done
exit $status
