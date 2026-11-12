#!/bin/sh
# Installs a packed @keelson-finance/verifier tarball into an empty folder, as a user would, and
# verifies a committed Alibi with its CLI and its library. Usage: check-package.sh <tarball>
set -e
tgz=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
sample=$(cd "$(dirname "$0")/../../.." && pwd)/packages/alibi/test/fixtures/01M6ZWZJHWRRHQEYNJAT7NMSV8.alibi
dir=$(mktemp -d)
cd "$dir"
npm init -y > /dev/null
npm install --no-audit --no-fund --ignore-scripts "$tgz" > /dev/null
npx keelson-verify "$sample" | head -1 | grep -q "^verified-offline"
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { verifyAlibi } from '@keelson-finance/verifier';
const report = await verifyAlibi(new Uint8Array(readFileSync('$sample')));
if (report.verdict !== 'verified-offline') throw new Error(report.verdict);
"
echo "@keelson-finance/verifier installs and verifies offline"
