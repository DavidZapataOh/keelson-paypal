#!/usr/bin/env bash
# Checks that the committed measurements.json carries a Sigstore build provenance attestation from
# this repository's workflows, and that a one-byte edit of it does not. Needs the GitHub CLI.
#
#   provenance-check.sh [measurements.json]
set -euo pipefail

repo=DavidZapataOh/keelson-paypal
file="${1:-$(dirname "${BASH_SOURCE[0]}")/../measurements.json}"

gh attestation verify "$file" --repo "$repo"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$file" "$tmp/measurements.json"
printf ' ' >> "$tmp/measurements.json"
if gh attestation verify "$tmp/measurements.json" --repo "$repo" >/dev/null 2>&1; then
  echo "FAIL an edited measurements.json verifies" >&2
  exit 1
fi
echo "ok: the committed file verifies and an edited copy does not"
