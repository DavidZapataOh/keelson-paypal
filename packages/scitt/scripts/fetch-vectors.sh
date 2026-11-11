#!/usr/bin/env bash
# Downloads the pinned conformance vectors and checks them against SHA256SUMS.
set -euo pipefail
cd "$(dirname "$0")/../test/vectors"
COSE_WG=https://raw.githubusercontent.com/cose-wg/Examples/53c9d634333bb4f529d78f5980fffa2667ee2c12
WYCHEPROOF=https://raw.githubusercontent.com/C2SP/wycheproof/dab4ea2ed021eb633874959ca601004f3457d911
mkdir -p cose-wg wycheproof
for f in sign-pass-01 sign-pass-02 sign-pass-03 sign-fail-01 sign-fail-02 sign-fail-03 sign-fail-04 sign-fail-06 sign-fail-07; do
  curl -fsSL "$COSE_WG/sign1-tests/$f.json" -o "cose-wg/$f.json"
done
for f in ecdsa_secp256k1_sha256_test ed25519_test; do
  curl -fsSL "$WYCHEPROOF/testvectors_v1/$f.json" -o "wycheproof/$f.json"
done
shasum -a 256 -c SHA256SUMS
