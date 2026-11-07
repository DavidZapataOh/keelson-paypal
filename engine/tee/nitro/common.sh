# shellcheck shell=bash disable=SC2034
# Helpers shared by the scripts in this directory. Source it; it does not run anything.
# The AWS CLI reads AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION (us-west-2).
set -euo pipefail

export AWS_PAGER=""
: "${AWS_REGION:?set AWS_REGION}"

NAME=keelson-tee-b
HOST=tee-b.keelson.finance
ZONE=keelson.finance
IMAGE=ghcr.io/davidzapataoh/keelson-engine
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The id of the parent instance, or nothing when there is none.
instance_id() {
  aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text
}

instance_state() {
  aws ec2 describe-instances --instance-ids "$1" --query 'Reservations[0].Instances[0].State.Name' --output text
}

wait_for_ssm() {
  for _ in $(seq 60); do
    [ "$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$1" \
      --query 'InstanceInformationList[0].PingStatus' --output text)" = Online ] && return 0
    sleep 5
  done
  echo "the instance never came online in SSM" >&2
  return 1
}

# Runs a script on the instance as root through SSM and prints its output; fails with its status.
ssm_run() {
  local parameters command status
  parameters="$(jq -n --arg script "$2" '{commands: [$script], executionTimeout: ["1800"]}')"
  command="$(aws ssm send-command --instance-ids "$1" --document-name AWS-RunShellScript \
    --parameters "$parameters" --query Command.CommandId --output text)"
  while :; do
    sleep 3
    status="$(aws ssm get-command-invocation --command-id "$command" --instance-id "$1" \
      --query Status --output text 2>/dev/null || echo Pending)"
    case "$status" in Pending | InProgress | Delayed) ;; *) break ;; esac
  done
  aws ssm get-command-invocation --command-id "$command" --instance-id "$1" \
    --query StandardOutputContent --output text
  if [ "$status" != Success ]; then
    aws ssm get-command-invocation --command-id "$command" --instance-id "$1" \
      --query StandardErrorContent --output text >&2
    echo "ssm command $status" >&2
    return 1
  fi
}

# The files in parent/ as a script that unpacks them on the instance.
unpack_parent() {
  printf 'mkdir -p /opt/keelson/parent && echo %s | base64 -d | tar -xz --no-same-owner -C /opt/keelson/parent\n' \
    "$(tar --no-xattrs -czf - -C "$HERE/parent" . | base64 | tr -d '\n')"
}
