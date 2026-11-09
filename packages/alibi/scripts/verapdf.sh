#!/usr/bin/env bash
# Validates PDFs as PDF/A-3b with veraPDF's official image; fails unless every file passes.
# Usage: scripts/verapdf.sh <file.pdf>...
set -euo pipefail
IMAGE="verapdf/cli:v1.30.2@sha256:d5ee329657cf9bc4b2400392dd54c7d0a0ce9980ff6fa2da5590eebeec007cdb"
status=0
for pdf in "$@"; do
  dir=$(cd "$(dirname "$pdf")" && pwd)
  out=$(docker run --rm -v "$dir":/data "$IMAGE" --format text -f 3b "/data/$(basename "$pdf")" || true)
  echo "$out"
  if [ -z "$out" ] || echo "$out" | grep -qv '^PASS '; then status=1; fi
done
exit "$status"
