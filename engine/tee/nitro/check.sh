#!/usr/bin/env bash
# Checks the running leg B: one enclave, not in debug mode, with the PCRs of eif.json, behind
# https://tee-b.keelson.finance, whose clock is within a second of the parent's. Needs AWS_* in the
# environment.
. "$(dirname "$0")/common.sh"

id="$(instance_id)"
[ -n "$id" ] || { echo "FAIL no parent instance" >&2; exit 1; }
[ "$(instance_state "$id")" = running ] || { echo "FAIL the parent is not running" >&2; exit 1; }

enclaves="$(ssm_run "$id" 'nitro-cli describe-enclaves')"
jq -e 'length == 1 and .[0].State == "RUNNING" and .[0].Flags == "NONE"' <<< "$enclaves" >/dev/null \
  || { echo "FAIL expected one RUNNING enclave outside debug mode" >&2; exit 1; }
for pcr in pcr0 pcr1 pcr2; do
  expected="$(jq -r ".$pcr" "$HERE/eif.json")"
  jq -e --arg pcr "$(tr a-z A-Z <<< "$pcr")" --arg expected "$expected" \
    '.[0].Measurements[$pcr] == $expected' <<< "$enclaves" >/dev/null \
    || { echo "FAIL $(tr a-z A-Z <<< "$pcr") differs from eif.json" >&2; exit 1; }
done

health="$(curl -fsS --max-time 10 "https://$HOST/v1/health")"
jq -e '.tee == 2' <<< "$health" >/dev/null || { echo "FAIL /v1/health is not tee 2: $health" >&2; exit 1; }
jq -e --arg digest "$(jq -r .digest "$HERE/eif.json")" '.oci_digest == $digest' <<< "$health" >/dev/null \
  || { echo "FAIL oci_digest differs from eif.json" >&2; exit 1; }
"$HERE/drift.sh" check 1000 >/dev/null
echo "ok $(jq -c '{signer, boot_epoch, oci_digest}' <<< "$health")"
