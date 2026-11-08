# Keelson contracts

> **Unaudited.** These contracts have not been audited. Use them on testnets, or on Arbitrum One only with amounts you can afford to lose.

Foundry project for Keelson's on-chain layer: bonds, coverage, slashing, the warranty reserve, checkpoint anchoring and the signer registry. Solidity 0.8.38 (`evm_version = "prague"`, `via_ir`, 200 optimizer runs), OpenZeppelin Contracts 5.7.0, Foundry 1.9.0.

## Layout

| Path                         | Contents                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`                       | Contracts. `src/access/` roles, `src/deploy/` the deterministic deployer, `src/interfaces/`, `src/libraries/`                                               |
| `test/`                      | `*.t.sol` local tests, `*.fork.t.sol` against forks pinned in the registry, `*.live.t.sol` against the live chains; `test/utils/` shared bases and fixtures |
| `script/`                    | Deploy, predict and verify scripts                                                                                                                          |
| `deployments/<chainId>.json` | Per-chain registry: inputs (RPC, fork block, external addresses, parameters, governance owners) and deployed addresses                                      |

## Commands

```sh
forge build --sizes
forge test --no-match-path 'test/**/*.live.t.sol'   # local and fork tests
forge test --match-path 'test/**/*.live.t.sol'      # live chains
forge snapshot --check --no-match-path 'test/**/*.{fork,live}.t.sol'
```

Fork and live tests read `ARBITRUM_SEPOLIA_RPC_URL`, `ARBITRUM_ONE_RPC_URL` and `ETHEREUM_SEPOLIA_RPC_URL`. The forks are pinned to fixed blocks, so the endpoints must serve archive state; public endpoints prune it. CI uses Alchemy (`https://arb-sepolia.g.alchemy.com/v2/<key>`, `https://arb-mainnet.g.alchemy.com/v2/<key>`, `https://eth-sepolia.g.alchemy.com/v2/<key>`) with the `ALCHEMY_API_KEY` secret; any archive endpoint works.

## Deterministic addresses

`KeelsonDeployer` is created through the deterministic CREATE2 factory (`0x4e59b44847b379578588920cA78FbF26c0B4956C`) with salt zero and its owner as constructor argument, so it has the same address on every chain. It deploys every other contract with CREATE3 (OpenZeppelin `Create3`): an address depends only on the salt `keccak256("keelson/v1/<ContractName>")`, never on constructor arguments, so each chain passes its own token and parameters and still lands on the same address. Only the owner can deploy. Nothing is upgradeable; a fix ships by bumping the release string and redeploying.

Bytecode is compiled without the CBOR metadata hash, so a deterministic address never moves because of a comment or a remapping. Sourcify reports these contracts as `match` rather than `exact_match`.

## Deployments

The same addresses on every chain. Arbitrum One has a registry (`deployments/42161.json`) and fork tests, and is not deployed yet.

| Contract                | Address                                      | Arbitrum Sepolia (421614)                                                                       | Sepolia (11155111)                                                                                |
| ----------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| KeelsonDeployer         | `0x539638ee1C4021730f9fA63b725c7E9bA02b714A` | [Arbiscan](https://sepolia.arbiscan.io/address/0x539638ee1C4021730f9fA63b725c7E9bA02b714A#code) | [Etherscan](https://sepolia.etherscan.io/address/0x539638ee1C4021730f9fA63b725c7E9bA02b714A#code) |
| AccessManager           | `0x57c30a4a175978673bAD2B2B2D3667966cd58314` | [Arbiscan](https://sepolia.arbiscan.io/address/0x57c30a4a175978673bAD2B2B2D3667966cd58314#code) | [Etherscan](https://sepolia.etherscan.io/address/0x57c30a4a175978673bAD2B2B2D3667966cd58314#code) |
| TimelockController      | `0xEDD241A9B8cf55765eDA7182483351555cf3E07e` | [Arbiscan](https://sepolia.arbiscan.io/address/0xEDD241A9B8cf55765eDA7182483351555cf3E07e#code) | [Etherscan](https://sepolia.etherscan.io/address/0xEDD241A9B8cf55765eDA7182483351555cf3E07e#code) |
| GuardianSafe            | `0x1cd0152d2d954Fc8c9436986C9F4B2C15903eF5C` | [Arbiscan](https://sepolia.arbiscan.io/address/0x1cd0152d2d954Fc8c9436986C9F4B2C15903eF5C#code) | [Etherscan](https://sepolia.etherscan.io/address/0x1cd0152d2d954Fc8c9436986C9F4B2C15903eF5C#code) |
| KeelsonBondVaultPreview | `0x69ccD2fB3a85f590F2A8f431cca3ecc2e9Bf3c14` | [Arbiscan](https://sepolia.arbiscan.io/address/0x69ccD2fB3a85f590F2A8f431cca3ecc2e9Bf3c14#code) | —                                                                                                 |

Governance: the TimelockController (5 min delay on testnets, 48 h on Arbitrum One) is the only admin of the AccessManager. The Guardian Safe (2-of-3) holds `GUARDIAN_ROLE` and can cancel timelock operations. Signer rotation (`SIGNERS_ROLE`) waits for the timelock and then the AccessManager's execution delay. The deployer holds no role.

Deploy and verify a chain:

```sh
forge script script/Deploy.s.sol --rpc-url <arbitrum_sepolia|sepolia|arbitrum> \
  --account keelson-deployer --password "$DEPLOYER_KEYSTORE_PASSWORD" --broadcast --slow
script/verify.sh <chainId>
```

On Sepolia, pass `--gas-estimate-multiplier 200`: its node underestimates the hand-over transactions. `script/Predict.s.sol` prints where any contract name lands before it is deployed.

## VerdictVerifier

`src/VerdictVerifier.sol` is the registry of the TEE signers and the `verifyingContract` of every EIP-712 message they sign (`Countersign`, `Verdict`, `Checkpoint`). It is not upgradeable.

A signer is registered by anyone, from a fresh attestation only:

| Path                        | Checks                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registerSignerWithQuote`   | Automata's DCAP attestation verifies the v4 TDX quote on-chain; TCB status UpToDate, or SWHardeningNeeded with advisories; not a debug TD; the dstack RTMR3 event log replays (SHA-384, `src/libraries/Sha384.sol`) to the quote's RTMR3; measurement `sha256(MRTD ‖ RTMR0 ‖ RTMR1 ‖ RTMR2 ‖ app-id ‖ compose-hash ‖ os-image-hash)` allowed |
| `registerSignerWithZkQuote` | The same, with Automata's verification proven in RISC Zero and checked by the same Automata entrypoint                                                                                                                                                                                                                                       |
| `registerSignerWithNitro`   | Base's `nitro-validator` checks the document and its cached certificate chain; PCR0–2 present and not zero; `public_key` is the signer; `nonce` is the bound block hash; issued at most 1 h ago and at most 10 min ahead; measurement `sha256(PCR0 ‖ PCR1 ‖ PCR2)` allowed                                                                   |

Every path requires `report_data = keccak256(abi.encode(keccak256("KEELSON_TEE_SIGNER_V1"), chainid, bondVault, teeKind, signer, policySetHash, engineBuildId, bootEpoch, issuerJwkThumbprint)) ‖ blockHash`, with the chain's own id, the `KeelsonBondVault` address, the configured issuer, and the hash of an Arbitrum block at most 14,400 blocks old read from the EIP-2935 history. One signer serves several chains, but each chain's attestation names that chain, so a signer is registered on each chain separately.

A signer is active for 72 h after its last registration, unless revoked by the Guardian (`revokeSigner`), by equivocation (`reportEquivocation`, two different `Countersign`s under one request id), or deactivated with its measurement (`disallowMeasurement`, Guardian, no delay). Allowing a measurement or changing the issuer waits for the timelock and the signers delay. `verify2of2(digest, tdx ‖ nitro)` and `verifyDegraded(digest, tdx)` answer for the bond vault, the anchor and the relayer.

Check a signer yourself:

```sh
cast call <VerdictVerifier> "signers(address)(uint8,uint40,uint40,uint40,bytes32)" <signer> --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL"
cast call <VerdictVerifier> "isActive(address,uint8)(bool)" <signer> 1 --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL"
```

Automata's on-chain PCCS must hold current Intel collateral for the leg's platform; `tools/dcap-collateral` checks it, weekly in CI. Deploy the Nitro validator first (`forge build --root lib/nitro-validator`, then `script/DeployNitroValidator.s.sol`), then `script/DeployVerdictVerifier.s.sol` (its `wire()` entrypoint executes the timelocked role wiring once the delay has passed).

## KeelsonBondVault

`src/KeelsonBondVault.sol` holds each operator's PYUSD bond, indexed by its ERC-8004 `agentId`, and locks part of it as coverage for each purchase. It is not upgradeable.

| Call                              | Who signs                                          | Checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `depositWithAuthorization`        | the depositor, EIP-3009 `ReceiveWithAuthorization` | nonce `keccak256(abi.encode(agentId, salt))`, so the authorization credits only that agent; the vault's PYUSD balance must grow by `amount` (PYUSD ignores a used nonce instead of reverting)                                                                                                                                                                                                                                                                                                                                                                                                       |
| `depositWithPermit`               | the agent's owner or agent wallet, ERC-2612        | a permit already used by someone else leaves the allowance, so its failure is ignored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `lockCoverage`                    | the user's passkey, the operator, both TEE legs    | the passkey assertion (`webauthn.get` or Secure Payment Confirmation `payment.get`, user verified, RP ID `keelson.finance`) over `M = SHA-256("keelson/mandate-challenge/v1" ‖ 0x00 ‖ H_sd ‖ C_m)` checked with P256VERIFY; the operator's `Coverage` signature (ERC-8004 owner or agent wallet, EOA or ERC-1271); the legs' `Countersign` through the `VerdictVerifier` (`tdx ‖ nitro`, or `tdx` alone for a degraded purchase, held at least 72 h); ALLOW, same request, agent, amount (cents × 10,000), USD and mandate; the coverage lasts the dispute window from the countersign's issue time |
| `lockCoverageBatch`               | the operator                                       | the batch names a checkpoint the `CheckpointAnchor` anchored for the vault's log; its root is an OpenZeppelin standard Merkle tree of the coverages' struct hashes                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `releaseCoverage`, `releaseBatch` | anyone                                             | after the window and grace, with no slash pending                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `requestWithdrawal`               | the agent's owner or agent wallet                  | nonce per signer; the destination is fixed in the signed request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `completeWithdrawal`              | anyone                                             | after the withdrawal delay, with no slash pending for the agent; queued funds stay slashable until then                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `setPayoutAddress`                | the merchant                                       | nonce per merchant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Limits of the on-chain checks: the passkey key `(qx, qy)` is calldata, not yet bound by anything the TEE legs sign, so the on-chain assertion proves only that some key signed `M`; the legs check the assertion against the mandate's disclosed key before countersigning, and `CoverageLocked` emits `userKeyHash` for off-chain comparison with the `cred` disclosure. `Coverage.merchant` and a batch's `total`, `root` and `expiresAt` are the operator's word, bounded by its own bond.

Every premium goes to the `KeelsonReserve` address in the same transaction. Operators, owners and merchants sign under the vault's EIP-712 domain `{Keelson, 1, chainId, vault}`; the legs sign under the `VerdictVerifier`'s. `@keelson/chain` builds every argument and typed message (`lockCoverageArgs`, `coverageTypedData`, `coverageBatch`, `withdrawalTypedData`, `payoutAddressTypedData`).

`setParams` takes `PARAMETERS_ROLE` (timelock) and requires `withdrawalDelay ≥ disputeWindow + vetoWindow + grace`; `pause` and `unpause` take `GUARDIAN_ROLE`. A pause stops new coverage only.

`script/DeployBondVault.s.sol` deploys a vault under any registry name and schedules its role wiring; `wire(name)` executes it after the timelock delay. The `KeelsonBondVaultPreview` vault on Arbitrum Sepolia runs the flow while the `KeelsonBondVault` address, which the legs' attestations bind, stays free for the vault with slashing. The demo operator (`demo` in the registry) owns its agent in the official ERC-8004 Identity registry (`script/RegisterOperator.s.sol`).

The fork tests (`test/BondVault*.fork.t.sol`) use coverages captured live (`test/vectors/coverage-*.json`, written by `services/api/test/coverage-vectors.live.test.ts`): the demo mandate signed in Chromium with a virtual authenticator through WebAuthn and through Secure Payment Confirmation, countersigned by the live legs, two of them 2-of-2 and one with leg B down. They read `KEELSON_FUNDER_KEYS`; on the fork the demo operator transfers its agent to a key the test holds, which then signs as the operator.

## Pause

The Guardian can pause new coverage. Pausing never enables withdrawing funds: there is no admin path that moves bonded PYUSD.
