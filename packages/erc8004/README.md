# @keelson/erc8004

Keelson's link to [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) ("Trustless Agents"). **ERC-8004 is a Draft standard; Keelson pins v2.0.0** of the official registries (`erc-8004/erc-8004-contracts` at `b9e466c250744a7e06b13dff9d3c2844ed64f825`).

- `ERC8004`, `agentRegistry(chainId)`: the official Identity and Reputation registries per chain, and the `eip155:<chainId>:<identity>` string agents are named by.
- `RegistrationFile`, `operatorRegistration(...)`: the agent registration file every Keelson operator publishes, advertising `supportedTrust` and its `keelson-bond` service.
- `OPERATOR_LINK_TYPES`, `verifyOperatorLink(...)`: the EIP-712 `OperatorLink` an agent's owner or agent wallet signs (EOA, ERC-1271 or ERC-6492) to link the agent to Keelson (`POST /v1/operators`).
- The official Identity and Reputation ABIs.

## Addresses

| Chain                       | IdentityRegistry                             | ReputationRegistry                           |
| --------------------------- | -------------------------------------------- | -------------------------------------------- |
| Arbitrum Sepolia (421614)   | [`0x8004A818…BD9e`](https://sepolia.arbiscan.io/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) | [`0x8004B663…8713`](https://sepolia.arbiscan.io/address/0x8004B663056A597Dffe9eCcC1965A193B7388713) |
| Sepolia (11155111)          | [`0x8004A818…BD9e`](https://sepolia.etherscan.io/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) | [`0x8004B663…8713`](https://sepolia.etherscan.io/address/0x8004B663056A597Dffe9eCcC1965A193B7388713) |
| Arbitrum One (42161)        | [`0x8004A169…a432`](https://arbiscan.io/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) | [`0x8004BAa1…9b63`](https://arbiscan.io/address/0x8004BAa17C55a88189AE136b182e5fdA19dE9b63) |

Keelson's own contracts, the same address on every chain (not yet deployed on Arbitrum One):

| Contract                    | Address                                      | Arbitrum Sepolia | Sepolia |
| --------------------------- | -------------------------------------------- | ---------------- | ------- |
| `KeelsonReputationReporter` | `0x0D736293957C481626553Bec31e46913A21FBc25` | [Arbiscan](https://sepolia.arbiscan.io/address/0x0D736293957C481626553Bec31e46913A21FBc25#code) | [Etherscan](https://sepolia.etherscan.io/address/0x0D736293957C481626553Bec31e46913A21FBc25#code) |
| `KeelsonValidationRegistry` | `0x2405d211CaAdFbB193287882fAb76e8A5D41f714` | [Arbiscan](https://sepolia.arbiscan.io/address/0x2405d211CaAdFbB193287882fAb76e8A5D41f714#code) | [Etherscan](https://sepolia.etherscan.io/address/0x2405d211CaAdFbB193287882fAb76e8A5D41f714#code) |

## What Keelson writes

**Reputation.** `KeelsonReputationReporter` is the bond vault's reputation client: once per coverage, anyone may ask it to rate the operator from the vault's state, `+100` with 2 decimals (`"keelson"`/`"release"`) for a clean release and `-100` (`"keelson"`/`"slash"`) for a paid slash. Two decimals, because the registry averages in the most frequent precision: `+1, +1, -1` with 0 decimals averages to `0`, while `+100, +100, -100` with 2 decimals gives `0.33`. Read an operator's record with:

```
getSummary(agentId, [0x0D736293957C481626553Bec31e46913A21FBc25], "keelson", "")       // all outcomes
getSummary(agentId, [0x0D736293957C481626553Bec31e46913A21FBc25], "keelson", "slash")  // slashes only
```

Each feedback's `feedbackURI` is `https://api.keelson.finance/v1/feedback/0x<coverageId>`, an off-chain feedback file the API builds from the chain.

**Validation.** `KeelsonValidationRegistry` holds one validation per Alibi with the `VerdictVerifier` as validator: `100` for an ALLOW whose coverage the vault locked, `0` for a DENY the operator asked to record, tagged `"2of2"` or `"degraded"`, then `"settled"` (100) or `"slashed"` (0) when the coverage ends. Unlike the ERC's flow, the request and response are not sent by the owner and the validator: they are proven by the operator's and the TEE legs' signatures, so anyone may submit them. `requestURI` is `https://api.keelson.finance/v1/validations/0x<requestHash>`.

The API serves each operator's files and on-chain record: `GET /v1/operators/{chainId}/{agentId}/registration.json`, `GET /v1/operators/by-address/{address}/registration.json`, `GET /v1/operators/{chainId}/{agentId}/bond`, `GET /v1/feedback/{coverageId}`, `GET /v1/validations/{requestHash}`.

## Demo operator

Agent `351` in the Arbitrum Sepolia Identity registry, owned by `0xcdA4d2330C027Aa025f4A14b525a386CE02AD98f`. Its `agentURI` is `https://api.keelson.finance/v1/operators/by-address/0xcdA4d2330C027Aa025f4A14b525a386CE02AD98f/registration.json`.

Its first live outcome on Arbitrum Sepolia, coverage `0x…01a1bb76cfae3f5b5d6e9db8898f3f2c` (94 PYUSD):

| Step                                       | Transaction | Gas |
| ------------------------------------------ | ----------- | --- |
| `recordCountersign` (ALLOW, 2-of-2)        | [`0x960ae0b3…073a`](https://sepolia.arbiscan.io/tx/0x960ae0b322e8207cba6c7f2ffeef4dd79382df2f8e9531089a48ddffbe81073a) | 288,675 |
| `releaseCoverage`                          | [`0x2285d87e…12fa`](https://sepolia.arbiscan.io/tx/0x2285d87e779f9e88d133424dff7b25292ebf060562f109bf221b03cd92aa12fa) | 38,499 |
| `rateCoverage` (`+100`, first feedback)    | [`0x2baf12e5…39fb`](https://sepolia.arbiscan.io/tx/0x2baf12e55d90f952a1018322660a63b4f8ad7f1682e55c5f513e8838782339fb) | 267,221 |
| `recordOutcome` (`"settled"`)              | [`0xc0086673…5286`](https://sepolia.arbiscan.io/tx/0xc00866739da732244bcb4414bc1b46cd9bc772b3838b5c630e31680843b65286) | 76,199 |

After them, `getSummary(351, [reporter], "keelson", "")` is `(1, 100, 2)` and the validation summary `(1, 100)`.
