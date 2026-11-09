#!/usr/bin/env bash
# Prices transactions on Arbitrum One from real calldata.
#
# Reads "<label> <tx hash>" lines on stdin, each a transaction already sent on Arbitrum Sepolia. For each it takes the
# transaction's calldata and its L2 execution gas (receipt gasUsed - gasUsedForL1), asks Arbitrum One's NodeInterface
# (0x...C8, gasEstimateL1Component) for the L1 component of the same calldata, and prices the sum at Arbitrum One's
# gas price and Chainlink's ETH/USD on Arbitrum One. Prints tab-separated rows and the block the prices were read at.
#
# Usage: script/arb-cost.sh < txs.txt
# Needs ARBITRUM_SEPOLIA_RPC_URL and ARBITRUM_ONE_RPC_URL.
set -euo pipefail

: "${ARBITRUM_SEPOLIA_RPC_URL:?}" "${ARBITRUM_ONE_RPC_URL:?}"
NODE_INTERFACE=0x00000000000000000000000000000000000000C8
ETH_USD=0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612

block=$(cast block-number --rpc-url "$ARBITRUM_ONE_RPC_URL")
gas_price=$(cast gas-price --rpc-url "$ARBITRUM_ONE_RPC_URL")
answer=$(cast call "$ETH_USD" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" \
  --block "$block" --rpc-url "$ARBITRUM_ONE_RPC_URL" | sed -n 2p | cut -d' ' -f1)
eth_usd=$(echo "scale=2; $answer / 100000000" | bc)

echo "# arbitrum one block $block, gas price $gas_price wei, ETH/USD $eth_usd (Chainlink)"
printf 'label\tcalldata_bytes\tl2_gas\tl1_gas_one\ttotal_gas\teth\tusd\n'
while read -r label hash; do
  [[ -z "$label" || "$label" == \#* ]] && continue
  tx=$(cast tx "$hash" --json --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL")
  receipt=$(cast receipt "$hash" --json --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL")
  input=$(jq -r .data.input <<<"$tx")
  to=$(jq -r '.data.to // empty' <<<"$tx")
  creation=false
  if [[ -z "$to" ]]; then
    to=0x0000000000000000000000000000000000000000
    creation=true
  fi
  l2=$(( $(jq -r .gasUsed <<<"$receipt") - $(jq -r '.gasUsedForL1 // "0x0"' <<<"$receipt") ))
  l1=$(cast call --gas-price "$gas_price" --block "$block" "$NODE_INTERFACE" \
    "gasEstimateL1Component(address,bool,bytes)(uint64,uint256,uint256)" "$to" "$creation" "$input" \
    --rpc-url "$ARBITRUM_ONE_RPC_URL" | head -1 | cut -d' ' -f1)
  total=$(( l2 + l1 ))
  eth=$(echo "scale=12; $total * $gas_price / 10^18" | bc)
  usd=$(echo "scale=6; $eth * $eth_usd" | bc)
  printf '%s\t%d\t%d\t%d\t%d\t%s\t%s\n' "$label" $(( (${#input} - 2) / 2 )) "$l2" "$l1" "$total" "$eth" "$usd"
done
