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

# out/<File>.sol/<Name>.json names its source in the compilation target.
source_of() {
  local name="$1" artifact
  for artifact in out/*/"$name".json; do
    jq -r --arg n "$name" '.metadata.settings.compilationTarget | to_entries[] | select(.value == $n) | "\(.key):\(.value)"' "$artifact"
    return
  done
  echo "no artifact for $name" >&2
  return 1
}

status=0
for chain in "$@"; do
  registry="deployments/$chain.json"
  for name in $(jq -r '.contracts | keys[]' "$registry"); do
    [[ "$name" == "GuardianSafe" ]] && continue
    address=$(jq -r --arg n "$name" '.contracts[$n]' "$registry")
    if $check_only; then
      sourcify=$(curl -fsS "https://sourcify.dev/server/v2/contract/$chain/$address" | jq -r '.match // empty')
      etherscan=$(curl -fsS "https://api.etherscan.io/v2/api?chainid=$chain&module=contract&action=getsourcecode&address=$address&apikey=$ETHERSCAN_API_KEY" |
        jq -r '.result[0].SourceCode // empty')
      if [[ "$sourcify" =~ ^(exact_match|match)$ && -n "$etherscan" ]]; then
        echo "$chain $name $address verified (sourcify: $sourcify)"
      else
        echo "$chain $name $address NOT verified (sourcify: ${sourcify:-none}, etherscan: ${etherscan:+yes})" >&2
        status=1
      fi
    else
      target=$(source_of "$name")
      args=$(jq -r --arg n "$name" '.constructorArgs[$n]' "$registry")
      # Foundry submits the same sources to Sourcify after Etherscan.
      forge verify-contract "$address" "$target" --chain "$chain" --verifier etherscan \
        --constructor-args "$args" --watch
    fi
  done
done
exit "$status"
