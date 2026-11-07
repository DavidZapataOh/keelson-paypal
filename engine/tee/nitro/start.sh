#!/usr/bin/env bash
# Starts a stopped parent and boots the enclave again. A stopped parent kills its enclave, so
# every start is a new signer.
. "$(dirname "$0")/common.sh"

id="$(instance_id)"
[ -n "$id" ] || { echo "no parent instance" >&2; exit 1; }
aws ec2 start-instances --instance-ids "$id" >/dev/null
aws ec2 wait instance-running --instance-ids "$id"
wait_for_ssm "$id"
exec "$HERE/update.sh" "$(jq -r .digest "$HERE/eif.json")" "$@"
