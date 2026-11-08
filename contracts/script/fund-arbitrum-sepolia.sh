#!/usr/bin/env bash
# Bridges Sepolia ETH to the deployer on Arbitrum Sepolia through the Arbitrum Sepolia Inbox (lands in ~10-15 min).
set -euo pipefail
cast send 0xaAe29B0366299461418F5324a79Afc425BE5ae21 'depositEth()' --value "${1:-0.02ether}" \
  --rpc-url sepolia --account keelson-deployer --password "$DEPLOYER_KEYSTORE_PASSWORD"
