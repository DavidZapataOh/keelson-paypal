#!/usr/bin/env bash
# Validates a CBOR or JSON file against a rule of a vendored CDDL file with the anweiss/cddl CLI.
# Usage: validate.sh <file.cddl> <rule> <data>
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
schema="$(mktemp)"
trap 'rm -f "$schema"' EXIT
# The cddl CLI ends a byte string at an escaped quote (RFC 8610 SESC), so the ABNF literals "\'"
# and "\\" of RFC 9999's Content-Type-ABNF are given as the same characters in ABNF's %x form.
{ echo "start = $2"; sed -e "s/\"\\\\'\"/%x27/g" -e 's/"\\\\"/%x5C/g' "$dir/$1"; } > "$schema"
case "$3" in
  *.json) input=--json ;;
  *) input=--cbor ;;
esac
# Without --ci the CLI only logs validation errors and exits 0.
"${CDDL_BIN:-cddl}" --ci validate --cddl "$schema" "$input" "$3"
