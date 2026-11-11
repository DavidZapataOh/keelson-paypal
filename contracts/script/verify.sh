#!/usr/bin/env bash
# Verifies every contract in deployments/<chainId>.json on Etherscan (API V2) and Sourcify.
#
#   script/verify.sh <chainId>...               submit each contract to both verifiers
#   script/verify.sh --check-only <chainId>...  fail unless both report every contract verified
#
# Needs ETHERSCAN_API_KEY and a prior `forge build`. The Guardian Safe is Safe's own audited proxy, which the
# explorers match on their own, so it is skipped.
set -euo pipefail
cd "$(dirname "$0")/.."

check_only=false
if [[ "${1:-}" == "--check-only" ]]; then
  check_only=true
  shift
fi
[[ $# -gt 0 ]] || { echo "usage: $0 [--check-only] <chainId>..." >&2; exit 2; }

# A registry name with the `Preview` suffix is the same contract deployed at another salt, and every `LogBond*` is a
# `LogBond` on another origin.
contract_of() {
  case "$1" in
    LogBond*) echo LogBond ;;
    *) echo "${1%Preview}" ;;
  esac
}

# out/<File>.sol/<Name>.json names its source in the compilation target. Contracts built with their own
# settings (Base's nitro-validator) are verified from their own project root.
EXTERNAL_ROOTS=(lib/nitro-validator)

root_of() {
  local name="$1" root
  for root in "${EXTERNAL_ROOTS[@]}"; do
    compgen -G "$root/out/*/$name.json" >/dev/null && { echo "$root"; return; }
  done
  echo .
}

source_of() {
  local name="$1" root artifact
  root="$(root_of "$name")"
  for artifact in "$root"/out/*/"$name".json; do
    jq -r --arg n "$name" '.metadata.settings.compilationTarget | to_entries[] | select(.value == $n) | "\(.key):\(.value)"' "$artifact"
    return
  done
  echo "no artifact for $name" >&2
  return 1
}

# Etherscan's free tier allows a few calls a second and answers a rate-limited call with a string `result`.
etherscan_source() {
  local body
  for _ in 1 2 3 4 5; do
    body=$(curl -fsS "https://api.etherscan.io/v2/api?chainid=$1&module=contract&action=getsourcecode&address=$2&apikey=$ETHERSCAN_API_KEY")
    if jq -e '.result | type == "array"' <<<"$body" >/dev/null; then
      jq -r '.result[0].SourceCode // empty' <<<"$body"
      return
    fi
    sleep 2
  done
}

# bb names every generated verifier HonkVerifier; the reference one is linked to two libraries.
target_of() {
  case "$1" in
    Mandate*Verifier | Anonymous*Verifier) echo "src/verifiers/$1.sol:HonkVerifier" ;;
    *) source_of "$(contract_of "$1")" ;;
  esac
}

# The verifiers and the SCL library are compiled without via-IR (foundry.toml `compilation_restrictions`); everything else in this
# project with the default profile. External roots have a single profile of their own.
profile_of() {
  if [[ "$1" =~ ^(Mandate|Anonymous).*Verifier$ || "$1" =~ ^(Ed25519Verifier|SCL_EIP6565)$ ]]; then
    echo "--compilation-profile legacy"
  elif [[ "$(root_of "$(contract_of "$1")")" == . ]]; then
    echo "--compilation-profile default"
  fi
}

# The libraries' CREATE3 addresses, predicted from the chain's registry.
libraries_of() {
  if [[ "$1" == Ed25519Verifier ]]; then
    echo "--libraries lib/crypto-lib/src/lib/libSCL_EIP6565.sol:SCL_EIP6565:$(jq -r .contracts.SCL_EIP6565 "deployments/$2.json")"
    return
  fi
  [[ "$1" =~ ^(Mandate|Anonymous).*ReferenceVerifier$ ]] || return 0
  local lib address
  for lib in RelationsLib ZKTranscriptLib; do
    address=$(forge script script/DeployMandatePredicateVerifier.s.sol --sig "predict(string)" "$1.$lib" \
      --chain "$2" --json 2>/dev/null | tail -1 | jq -r '.returns["0"].value')
    [[ "$address" =~ ^0x[0-9a-fA-F]{40}$ && "$address" != 0x0000000000000000000000000000000000000000 ]] ||
      { echo "no address for $1.$lib on $2" >&2; return 1; }
    echo "--libraries src/verifiers/$1.sol:$lib:$address"
  done
}

status=0
for chain in "$@"; do
  registry="deployments/$chain.json"
  for name in $(jq -r '.contracts | keys[]' "$registry"); do
    [[ "$name" == "GuardianSafe" ]] && continue
    address=$(jq -r --arg n "$name" '.contracts[$n]' "$registry")
    if $check_only; then
      sourcify=$(curl -fsS "https://sourcify.dev/server/v2/contract/$chain/$address" | jq -r '.match // empty')
      etherscan=$(etherscan_source "$chain" "$address")
      if [[ "$sourcify" =~ ^(exact_match|match)$ && -n "$etherscan" ]]; then
        echo "$chain $name $address verified (sourcify: $sourcify)"
      else
        echo "$chain $name $address NOT verified (sourcify: ${sourcify:-none}, etherscan: ${etherscan:+yes})" >&2
        status=1
      fi
    else
      target=$(target_of "$name")
      args=$(jq -r --arg n "$name" '.constructorArgs[$n]' "$registry")
      libraries=$(libraries_of "$name" "$chain")
      # Foundry submits the same sources to Sourcify after Etherscan.
      forge verify-contract "$address" "$target" --chain "$chain" --verifier etherscan $(profile_of "$name") \
        --constructor-args "$args" --root "$(root_of "$(contract_of "$name")")" $libraries --watch
    fi
  done
done
exit "$status"
