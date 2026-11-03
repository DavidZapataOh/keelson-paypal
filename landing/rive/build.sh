#!/bin/sh
# Regenerates every artboard, builds the shared .riv and publishes it to the site.
set -e
cd "$(dirname "$0")"
for f in tools/build_*.py; do (cd tools && PYTHONDONTWRITEBYTECODE=1 python3 "$(basename "$f")"); done
rive landing --once
cp landing/build/keelson-landing.riv ../public/rive/landing.riv
echo "published public/rive/landing.riv"
