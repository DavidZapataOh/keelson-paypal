#!/usr/bin/env bash
# Usage: tamper.sh <name> <proof dir> <vk>
# Verifies the proof in <proof dir> once per public input, with that input's last byte flipped,
# and fails naming the first copy that still verifies: an input the proof does not bind.
# TAMPER_SELFTEST=1 leaves the inputs as they are, so the run must fail; it checks the harness.
# Needs bb and xxd on PATH.
set -euo pipefail
name=$1 proof=$2/proof inputs=$2/public_inputs vk=$3

if ! bb verify -k "$vk" -p "$proof" -i "$inputs" -t evm >/dev/null 2>&1; then
  echo "$name: the proof does not verify with its own public inputs" >&2
  exit 1
fi

hex=$(xxd -p -c0 "$inputs")
n=$((${#hex} / 64))
tampered=$(mktemp)
trap 'rm -f "$tampered"' EXIT
for ((i = 0; i < n; i++)); do
  at=$((i * 64 + 62))
  byte=${hex:at:2}
  if [ -z "${TAMPER_SELFTEST:-}" ]; then
    byte=$(printf '%02x' $((0x$byte ^ 1)))
  fi
  echo "${hex:0:at}$byte${hex:at+2}" | xxd -r -p >"$tampered"
  if bb verify -k "$vk" -p "$proof" -i "$tampered" -t evm >/dev/null 2>&1; then
    echo "$name: public input $i still verifies" >&2
    exit 1
  fi
done
echo "$name: $n of $n public inputs bound"
