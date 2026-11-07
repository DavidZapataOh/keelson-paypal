#!/usr/bin/env bash
# Measures the enclave's clock against the parent's, and against leg A's, for a day.
#
#   drift.sh start <leg A url>   samples every 5 minutes for 24 hours as a systemd unit
#   drift.sh check [max ms]      samples once and fails when leg B is further than max ms
#                                (1000 by default) from the parent's clock
#   drift.sh summary             prints the largest drifts logged so far
#   drift.sh log                 prints the log
#   drift.sh stop
. "$(dirname "$0")/common.sh"

id="$(instance_id)"
[ -n "$id" ] && [ "$(instance_state "$id")" = running ] || { echo "no running parent" >&2; exit 1; }
unit=keelson-clock-drift
log=/var/log/keelson-clock-drift.jsonl

script="$(base64 < "$HERE/../scripts/clock-drift.ts" | tr -d '\n')"
install="echo $script | base64 -d > /opt/keelson/clock-drift.ts"

case "${1:-}" in
  start)
    a="${2:?usage: drift.sh start <leg A url>}"
    ssm_run "$id" "set -euo pipefail
$install
systemctl stop $unit 2>/dev/null || true
systemctl reset-failed $unit 2>/dev/null || true
: > $log
systemd-run --unit $unit --description='Keelson enclave clock drift' \
  /usr/local/bin/node /opt/keelson/clock-drift.ts --b http://127.0.0.1:8000 --a '$a' --every 300 --for 86400 --log $log
systemctl is-active $unit"
    ;;
  check)
    max="${2:-1000}"
    [[ "$max" =~ ^[0-9]+$ ]] || { echo "usage: drift.sh check [max ms]" >&2; exit 1; }
    ssm_run "$id" "set -euo pipefail
$install
/usr/local/bin/node /opt/keelson/clock-drift.ts --b http://127.0.0.1:8000 --check $max" \
      || { echo "FAIL leg B's clock is more than $max ms from the parent's" >&2; exit 1; }
    ;;
  summary) ssm_run "$id" "node /opt/keelson/clock-drift.ts --summary $log" ;;
  log) ssm_run "$id" "cat $log" ;;
  stop) ssm_run "$id" "systemctl stop $unit" ;;
  *) echo "usage: drift.sh start <leg A url> | check [max ms] | summary | log | stop" >&2; exit 1 ;;
esac
