#!/usr/bin/env bash
# Health of the hourly judge journey: exits 1 when the last run did not pass or when runs went missing.
#   journey-health.sh [--hours N] [--stats]
# --stats prints p50/p95 of the tour time (totalMs) over the green runs in the window.
set -euo pipefail

hours=24
stats=false
while [ $# -gt 0 ]; do
  case "$1" in
    --hours) hours="$2"; shift 2 ;;
    --stats) stats=true; shift ;;
    *) echo "usage: $0 [--hours N] [--stats]" >&2; exit 2 ;;
  esac
done

runs=$(gh run list --workflow judge-journey.yml --branch main --limit 200 \
  --json conclusion,status,createdAt,event,databaseId \
  --jq "[.[] | select(.status == \"completed\")
             | select((.createdAt | fromdateiso8601) >= (now - $hours * 3600))]")

count=$(jq length <<<"$runs")
passed=$(jq '[.[] | select(.conclusion == "success")] | length' <<<"$runs")
echo "$count runs in $hours h, $passed passed"

status=0
last=$(jq -r 'sort_by(.createdAt) | last // empty | "\(.databaseId) \(.conclusion)"' <<<"$runs")
if [ -z "$last" ]; then
  echo "no run in the last $hours h"
  status=1
elif [ "${last#* }" != "success" ]; then
  echo "last run ${last% *} ${last#* }"
  status=1
fi

expected=$((hours - 2))
if [ "$count" -lt "$expected" ]; then
  echo "$count runs in $hours h, expected ≥ $expected"
  status=1
fi

if $stats; then
  for id in $(jq -r '.[] | select(.conclusion == "success") | .databaseId' <<<"$runs" | head -24); do
    gh run view "$id" --log 2>/dev/null | grep -o '{"origin".*}' | head -1 | jq '.totalMs' || true
  done | sort -n | awk '
    { v[NR] = $1 }
    END {
      if (NR == 0) { print "no tour times"; exit }
      p50 = v[int((NR - 1) * 0.50) + 1]; p95 = v[int((NR - 1) * 0.95) + 1]
      printf "tour totalMs over %d green runs: p50 %d, p95 %d\n", NR, p50, p95
    }'
fi

exit "$status"
