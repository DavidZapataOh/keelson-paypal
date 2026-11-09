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

# A registry name with the `Preview` suffix is the same contract deployed at another salt.
contract_of() { echo "${1%Preview}"; }

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
      target=$(source_of "$(contract_of "$name")")
      args=$(jq -r --arg n "$name" '.constructorArgs[$n]' "$registry")
      # Foundry submits the same sources to Sourcify after Etherscan.
      forge verify-contract "$address" "$target" --chain "$chain" --verifier etherscan \
        --constructor-args "$args" --root "$(root_of "$(contract_of "$name")")" --watch
    fi
  done
done
exit "$status"
