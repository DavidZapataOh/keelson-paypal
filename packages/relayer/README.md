# @keelson/relayer

Sends Keelson's signature-native contract calls on Arbitrum and pays their gas, so operators, merchants and buyers never hold ETH. A library, not a service: the API (and any other process) creates a relayer over the shared Postgres, and every process can send from the same address.

- **Simulate first.** Each call is checked against an allowlist of permissionless Keelson functions, then simulated with `eth_estimateGas`. A refused or reverting call costs nothing and spends no nonce; the contract's custom error comes back decoded.
- **Never twice.** Every call is recorded in `chain_txs` under an idempotency key (`<contract>.<function>:<natural id>`). The signed bytes are stored before broadcast; a lost answer re-broadcasts the same bytes and never re-signs. Only a definite refusal from the sequencer (`nonce too low` without our receipt, `nonce too high`) re-signs, at most three times.
- **Nonces in Postgres.** One atomic statement hands out each nonce. A nonce that was handed out and never sent is healed by the next send: the sequencer refuses its successor with `nonce too high` after one second, and the allocator moves back to the chain's count. A successor that only arrived first waits for its predecessor instead.
- **Keys in KMS.** The secp256k1 keys are created inside AWS KMS and never leave it. Signatures are normalized to low-S and carry the recovery bit that recovers the key's address.
- **One round trip.** Transactions go straight to the sequencer with `eth_sendRawTransactionSync` (EIP-7966), which answers with the receipt. A reconciler settles pending rows every 5 s and replaces receipts with their canonical copy for two minutes.

## Environment

| Chain                     | Sender (KMS alias)                       | Address                                      | Writes                                             | Minimum balance | Base fee cap |
| ------------------------- | ---------------------------------------- | -------------------------------------------- | -------------------------------------------------- | --------------- | ------------ |
| Arbitrum Sepolia (421614) | `alias/keelson-relayer-arbitrum-sepolia` | `0xEd4Aa68f4e0c704422894b072deDa99807Fb2915` | `https://sepolia-rollup-sequencer.arbitrum.io/rpc` | 0.01 ETH        | 1 gwei       |
| Arbitrum One (42161)      | `alias/keelson-relayer-arbitrum-one`     | `0x1f1645054EC4240b9f4BdCc1E14F380Bc827a7c8` | `https://arb1-sequencer.arbitrum.io/rpc`           | 0.0005 ETH      | 0.1 gwei     |

Both keys are `ECC_SECG_P256K1` / `SIGN_VERIFY` in `us-west-2`. The IAM user `keelson-relayer` may only call `kms:GetPublicKey` and `kms:Sign` (with `ECDSA_SHA_256` over a `DIGEST`) on those two keys. The relayer addresses hold no role in any Keelson contract.

| Variable                                                     | Meaning                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `RELAYER_KMS_KEY_SANDBOX`, `RELAYER_KMS_KEY_LIVE`            | The KMS key of each chain's sender; a chain without one is not relayed on. |
| `RELAYER_AWS_ACCESS_KEY_ID`, `RELAYER_AWS_SECRET_ACCESS_KEY` | The `keelson-relayer` IAM user's access key.                               |
| `AWS_REGION`                                                 | `us-west-2`.                                                               |
| `ARBITRUM_SEPOLIA_RPC_URL`, `ARBITRUM_ONE_RPC_URL`           | The read RPC of each chain; the chain's public RPC is the fallback.        |

`scripts/kms-setup.sh` creates the keys, their aliases, the IAM user and its policy, and prints both addresses; it is idempotent.

## Operations

- **Refill.** Send ETH to the sender's address. Below the minimum balance, `/status` reports the relayer `degraded` and submissions answer `503 relayer-low-balance`.
- **Rotate a key.** Create a new key (`aws kms create-key --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY`), point the alias at it (`aws kms update-alias`), add its ARN to the IAM policy, fund its address and redeploy; then drain the old address. Disable the old key, and schedule its deletion once nothing is pending from it.
- **Revoke.** Deactivating the IAM user's access key stops every signature at once; CloudTrail records each `Sign`.

## Tests

Unit tests run on an anvil fork of Arbitrum Sepolia with the deployed contracts and real PYUSD, the real Postgres and the real sandbox KMS key (`ARBITRUM_SEPOLIA_RPC_URL`, `KEELSON_FUNDER_KEYS`, `DATABASE_URL`, and the relayer's AWS key). `pnpm test:live` sends real Arbitrum Sepolia transactions: the nonce-gap recovery on the sequencer and 100 concurrent deposits from two processes.
