#!/usr/bin/env bash
# Stops the parent, and with it the enclave. The Elastic IP and the disk stay.
. "$(dirname "$0")/common.sh"

id="$(instance_id)"
[ -n "$id" ] || { echo "no parent instance" >&2; exit 1; }
aws ec2 stop-instances --instance-ids "$id" >/dev/null
aws ec2 wait instance-stopped --instance-ids "$id"
