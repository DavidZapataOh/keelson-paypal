#!/usr/bin/env bash
# Validates a CBOR or JSON file against a rule of a vendored CDDL file with the RFC 8610 reference
# tool (the cddl gem), which exits non-zero when the instance does not match.
# Usage: validate.sh <file.cddl> <rule> <data>
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
schema="$(mktemp)"
trap 'rm -f "$schema"' EXIT
{ echo "start = $2"; cat "$dir/$1"; } > "$schema"
"${CDDL_BIN:-cddl}" "$schema" validate "$3"
