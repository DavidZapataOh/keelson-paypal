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

| Contract                          | Address                                      | Arbitrum Sepolia (421614)                                                                       | Sepolia (11155111)                                                                                |
| --------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| KeelsonDeployer                   | `0x539638ee1C4021730f9fA63b725c7E9bA02b714A` | [Arbiscan](https://sepolia.arbiscan.io/address/0x539638ee1C4021730f9fA63b725c7E9bA02b714A#code) | [Etherscan](https://sepolia.etherscan.io/address/0x539638ee1C4021730f9fA63b725c7E9bA02b714A#code) |
| AccessManager                     | `0x57c30a4a175978673bAD2B2B2D3667966cd58314` | [Arbiscan](https://sepolia.arbiscan.io/address/0x57c30a4a175978673bAD2B2B2D3667966cd58314#code) | [Etherscan](https://sepolia.etherscan.io/address/0x57c30a4a175978673bAD2B2B2D3667966cd58314#code) |
| TimelockController                | `0xEDD241A9B8cf55765eDA7182483351555cf3E07e` | [Arbiscan](https://sepolia.arbiscan.io/address/0xEDD241A9B8cf55765eDA7182483351555cf3E07e#code) | [Etherscan](https://sepolia.etherscan.io/address/0xEDD241A9B8cf55765eDA7182483351555cf3E07e#code) |
| GuardianSafe                      | `0x1cd0152d2d954Fc8c9436986C9F4B2C15903eF5C` | [Arbiscan](https://sepolia.arbiscan.io/address/0x1cd0152d2d954Fc8c9436986C9F4B2C15903eF5C#code) | [Etherscan](https://sepolia.etherscan.io/address/0x1cd0152d2d954Fc8c9436986C9F4B2C15903eF5C#code) |
| KeelsonBondVaultPreview           | `0x69ccD2fB3a85f590F2A8f431cca3ecc2e9Bf3c14` | [Arbiscan](https://sepolia.arbiscan.io/address/0x69ccD2fB3a85f590F2A8f431cca3ecc2e9Bf3c14#code) | —                                                                                                 |
| KeelsonBondVault                  | `0xb39898Ef4333f3CB32d1B420E744f5a1Aa2ae2Bf` | [Arbiscan](https://sepolia.arbiscan.io/address/0xb39898Ef4333f3CB32d1B420E744f5a1Aa2ae2Bf#code) | —                                                                                                 |
| KeelsonReserve                    | `0xd10Cb524B3C5EC3c60A420e8900e4f8C5aB88972` | [Arbiscan](https://sepolia.arbiscan.io/address/0xd10Cb524B3C5EC3c60A420e8900e4f8C5aB88972#code) | —                                                                                                 |
| KeelsonValidationRegistry         | `0x2405d211CaAdFbB193287882fAb76e8A5D41f714` | [Arbiscan](https://sepolia.arbiscan.io/address/0x2405d211CaAdFbB193287882fAb76e8A5D41f714#code) | [Etherscan](https://sepolia.etherscan.io/address/0x2405d211CaAdFbB193287882fAb76e8A5D41f714#code) |
| KeelsonReputationReporter         | `0x0D736293957C481626553Bec31e46913A21FBc25` | [Arbiscan](https://sepolia.arbiscan.io/address/0x0D736293957C481626553Bec31e46913A21FBc25#code) | [Etherscan](https://sepolia.etherscan.io/address/0x0D736293957C481626553Bec31e46913A21FBc25#code) |
| MandatePredicateVerifier          | `0x3940A0D26f0Fbac6e9d43Fe8b3F69B8bd6CDA2a0` | [Arbiscan](https://sepolia.arbiscan.io/address/0x3940A0D26f0Fbac6e9d43Fe8b3F69B8bd6CDA2a0#code) | —                                                                                                 |
| MandatePredicateReferenceVerifier | `0x7D82a52d7e5Cb71D594B2F826d769FF64b26B046` | [Arbiscan](https://sepolia.arbiscan.io/address/0x7D82a52d7e5Cb71D594B2F826d769FF64b26B046#code) | —                                                                                                 |

The C1 verifiers (`src/verifiers/`) are generated by `bb write_solidity_verifier -t evm` from the circuit in `circuits/c1` (`circuits/c1/build.sh`): the optimized one (`--optimized`, 15.7 KB, 646k gas per `verify`) is what a merchant `eth_call`s; the standard one (18.2 KB, 2.27M gas) is deployed as the reference path, since the optimized verifier has no public audit. They are compiled without via-IR, which runs out of stack on them, and `script/DeployMandatePredicateVerifier.s.sol` deploys them from their artifacts, linking the standard one to its two libraries at their CREATE3 addresses.

`MandateViolationCourt` convicts a coverage whose purchase violated its mandate, with no trust in Keelson: anyone holding the mandate's opening proves, with the C2a `mandate_violation` circuit (`circuits/c2a`), that the cart of the countersign the coverage was locked with exceeds the maximum amount, is in another currency, is of a category the mandate excludes, came after the mandate expired, or is from a merchant outside the mandate's ordered merchant tree (a non-membership proof). The court checks the coverage against the vault's `coverageHash`, the countersign against the coverage as `lockCoverage` does, and the countersign's signers as registered, unrevoked and under an allowed measurement at its `issuedAt`, so a conviction can come after their registrations lapsed. It records one conviction per coverage and has no roles. The vault is not upgradeable and its slash takes a verdict the TEE legs sign, so a conviction makes the operator liable under the attribution rule for a missing valid proof (R00), and the slash is the vault's usual one. Its C2a verifiers are generated and deployed like the C1 ones (`circuits/c2a/build.sh`, `script/DeployMandateViolationCourt.s.sol`).

Governance: the TimelockController (5 min delay on testnets, 48 h on Arbitrum One) is the only admin of the AccessManager. The Guardian Safe (2-of-3) holds `GUARDIAN_ROLE` and can cancel timelock operations. Signer rotation (`SIGNERS_ROLE`) waits for the timelock and then the AccessManager's execution delay. The deployer holds no role.

Deploy and verify a chain:

```sh
forge script script/Deploy.s.sol --rpc-url <arbitrum_sepolia|sepolia|arbitrum> \
  --account keelson-deployer --password "$DEPLOYER_KEYSTORE_PASSWORD" --broadcast --slow
script/verify.sh <chainId>
```

On Sepolia, pass `--gas-estimate-multiplier 200`: its node underestimates the hand-over transactions. Sepolia also prices contract creation above what Foundry's local EVM simulates, so deployments there need `--skip-simulation`, which takes each transaction's gas from the node. `script/Predict.s.sol` prints where any contract name lands before it is deployed.

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

Limits of the on-chain checks: the passkey key `(qx, qy)` must hash to the `userKeyHash` the operator signed in `Coverage`, so nobody who copies the operator's signature and the countersignatures from a pending transaction can lock the coverage with a key of their own. The chain cannot open the mandate's selectively disclosed `cred`, so that the operator named the user's key is checked by the legs (the assertion against the disclosed key, before countersigning) and off-chain against the Alibi, whose `cred` disclosure must hash to the `userKeyHash` in `CoverageLocked`. `Coverage.merchant` and a batch's `total`, `root` and `expiresAt` are the operator's word, bounded by its own bond; no payout reads `Coverage.merchant`: a slash or a warranty pays the `payee` of the TEE-signed `Verdict`.

Every premium goes to the `KeelsonReserve` address in the same transaction. Operators, owners and merchants sign under the vault's EIP-712 domain `{Keelson, 1, chainId, vault}`; the legs sign under the `VerdictVerifier`'s. `@keelson/chain` builds every argument and typed message (`lockCoverageArgs`, `coverageTypedData`, `coverageBatch`, `withdrawalTypedData`, `payoutAddressTypedData`).

`setParams` and `setRateLimit` take `PARAMETERS_ROLE` (timelock); `setParams` requires `withdrawalDelay ≥ disputeWindow + vetoWindow + grace`. `pause`, `unpause` and `vetoSlash` take `GUARDIAN_ROLE`. A pause stops new coverage only.

`script/DeployBondVault.s.sol` deploys a vault under any registry name and schedules its role wiring; `wire(name)` executes it after the timelock delay. The `KeelsonBondVault` address is the one the legs' attestations bind; the earlier `KeelsonBondVaultPreview` (no slashing) is retired and empty. The demo operator (`demo` in the registry) owns its agent in the official ERC-8004 Identity registry (`script/RegisterOperator.s.sol`).

### Slashing

| Call           | Who signs                                       | Checks                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `slash`        | both TEE legs, or the TDX leg alone (`Verdict`) | in order: the signatures (`InvalidVerdictSignature`); `liable == 1`, the operator (`NotOperatorLiable`); the dispute not yet settled by the vault or the reserve (`AlreadySettled`); the verdict's deadline (`Expired`); `checkpointRoot` anchored for the vault's log at `treeSize` (`NotAnchored`); the coverage active, not past `releaseAfter`, same agent (`CoverageNotActive`); at most what is left of it (`ExceedsCoverage`) |
| `slashBatched` | as `slash`                                      | as `slash`, for a coverage proven in a locked batch by its Merkle proof (`NotInBatch`), within the coverage and the batch                                                                                                                                                                                                                                                                                                            |
| `executeSlash` | anyone                                          | a queued slash (`NotQueued`) once its window passed (`NotReady`), within the rate limit (`RateLimitExceeded`)                                                                                                                                                                                                                                                                                                                        |
| `vetoSlash`    | the Guardian                                    | a queued slash inside its window (`VetoClosed`); restores the coverage, moves no funds, the dispute stays settled                                                                                                                                                                                                                                                                                                                    |
| `claim`        | the account (`Claim`), or the account itself    | pays every failed payout of the account to the address it names; nonce per account                                                                                                                                                                                                                                                                                                                                                   |

A slash pays the `payee` of the verdict (or its payout address) from the coverage's locked funds; a zero amount or payee is refused, and one coverage pays at most its amount across slashes and warranties. A batch leaf whose id is also a coverage locked on its own cannot be slashed through the batch. It pays at once unless it is degraded (the coverage was countersigned by the TDX leg alone, or the verdict is), larger than `instantSlashCap`, or beyond the rate limit (OpenZeppelin `RateLimiter.RefillingBucket`, one global bucket of `slashRateCapacity` PYUSD per `slashRateWindow`); then it waits `vetoWindow` (72 h when degraded) for the Guardian, who can only cancel it. A queued slash larger than the whole bucket takes the full bucket when it executes, so it can never be stuck. A transfer that fails (Paxos froze the payee or the vault, PYUSD paused) leaves the amount in `claimable`, never reverts; the payee later sends it anywhere with a signed `Claim`. `Slashed` carries the EIP-712 digest of the verdict the legs signed. A slash, an execution and a claim all work while the vault is paused.

Until the legs sign verdicts, the fork tests sign them with two keys written into the forked `VerdictVerifier` as one TDX and one Nitro signer under the live measurements (`test/utils/VerdictSigners.sol`); they exist only on the fork. `test/Settlement.fork.t.sol` reads `test/vectors/verdict-amber.json` and `verdict-green.json` instead when they exist (`{verdict, treeSize, signatures: {tdx, nitro}}`, signed by the live legs).

## KeelsonReserve

An ERC-4626 vault over PYUSD (`kwPYUSD`, OpenZeppelin `ERC4626` with a 6-decimal virtual offset against the first-depositor inflation attack). It receives every premium the vault charges, so the premiums raise the share price, and pays warranties:

- `payWarranty(verdict, treeSize, sigs)`: both legs' signatures only, `liable == 2` (Keelson), a non-zero amount and payee, the dispute not yet settled by the reserve or the vault, the deadline, an anchored `checkpointRoot`, a coverage the vault locked for the same agent (released or not, until one dispute window after its release), at most what slashes and earlier warranties left of it, at most `totalAssets()`, and within the reserve's own rate limit (`warrantyRateCapacity` per `warrantyRateWindow`; beyond it the call reverts and can be retried). It pays the verdict's `payee`, or the payout address the merchant set in the vault; a failed transfer becomes a claim (`claim`, signed `Claim` under the reserve's own domain) and leaves `totalAssets()`. Coverages locked in a batch have no warranty.
- Withdrawals: `requestCooldown()`, then `withdraw`/`redeem` only between `cooldown` and `cooldown + unstakeWindow` after it (`reserveCooldown`/`reserveUnstakeWindow`: one dispute window and one day on testnets, 20 days and 2 days in the Arbitrum One registry). Shares cannot be moved or minted to an owner whose cooldown runs. `setCooldown` and `setRateLimit` take `PARAMETERS_ROLE`.

`script/DeployReserve.s.sol` deploys it at its CREATE3 address, the one the vault sends premiums to, and wires its roles. Deploy and seed it before the vault locks any coverage: the vault's `slash` reads the reserve, and premiums that reach it before the first deposit mostly accrue to the virtual shares.

The testnet windows are demo values (veto 2 minutes, grace 1 minute); production uses a 24 h veto window and 3 days of grace, long enough for the 2-of-3 Guardian to act. No coverage is locked before the role wiring has executed.

The fork tests (`test/BondVault*.fork.t.sol`, `test/Reserve.fork.t.sol`, `test/Settlement.fork.t.sol`) use coverages captured live (`test/vectors/coverage-*.json`, written by `services/api/test/coverage-vectors.live.test.ts`): the demo mandate signed in Chromium with a virtual authenticator through WebAuthn and through Secure Payment Confirmation, countersigned by the live legs, two of them 2-of-2 and one with leg B down. They read `KEELSON_FUNDER_KEYS`; on the fork the demo operator transfers its agent to a key the test holds, which then signs as the operator. PYUSD beyond the funders' faucet balances comes from the faucet's own wallet (`external.pyusdHolder`) by plain transfers on the fork.

## ERC-8004

Keelson builds on [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) ("Trustless Agents"), which is a Draft standard. Keelson pins the official registries at v2.0.0 (`erc-8004/erc-8004-contracts` at `b9e466c`): bonds are keyed by the `agentId` of the official Identity registry, operators are rated on the official Reputation registry, and each Alibi gets a validation in Keelson's own Validation registry. The official registries are upgradeable by their authors; nothing in the vault depends on them beyond `ownerOf` and `getAgentWallet`.

| Chain                     | IdentityRegistry                             | ReputationRegistry                           |
| ------------------------- | -------------------------------------------- | -------------------------------------------- |
| Arbitrum Sepolia, Sepolia | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Arbitrum One              | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |

The two networks use different registry addresses, so both contracts below take them as constructor arguments: their CREATE3 addresses are the same on every chain, their runtime bytecode is not.

### KeelsonReputationReporter

`src/KeelsonReputationReporter.sol` is the bond vault's reputation client: it is the `clientAddress` of every rating Keelson gives on the official Reputation registry. The vault itself is frozen at the address the TEE legs' attestations bind, so its ratings come from this separate, ownerless contract that reads the vault's state:

| Coverage, as the vault reports it                                         | `rateCoverage(coverageId)` gives            |
| ------------------------------------------------------------------------- | ------------------------------------------- |
| `Released` and `slashed(coverageId) == 0`                                 | `+100`, 2 decimals, `"keelson"`/`"release"` |
| `slashed(coverageId) > 0`, no slash pending for the coverage or its agent | `-100`, 2 decimals, `"keelson"`/`"slash"`   |
| a slash still queued, or an active coverage with nothing slashed          | reverts `OutcomeNotFinal`                   |

Anyone may call it, once per coverage. A vetoed slash restores the coverage, which is then rated on its release. Coverages locked in a batch have no per-coverage state in the vault and are not rated. Read an operator's record with `getSummary(agentId, [reporter], "keelson", "")`, and its slashes with the `"slash"` filter; the values have two decimals because the registry averages in the most frequent precision and would truncate `±1` to `0`. The vault's `Slashed` events and `slashCount` remain the authoritative record.

The registry refuses feedback from the agent's owner or anyone it approved. An operator that approves the reporter, or transfers its agent to it, makes the feedback fail: `rateCoverage` emits `FeedbackSkipped`, leaves the coverage unrated and can be called again later. While a refused `-1.00` is outstanding, no `+1.00` of that agent is given (`SlashUnrated`), so revoking the approval only around its own clean releases gains an operator nothing. The call to the registry gets a fixed stipend of `REPUTATION_GAS` (1.5 times its measured worst case) and copies no revert data; `rateCoverage` reverts `InsufficientGas` unless the full stipend is available, so no gas limit makes it skip the feedback.

### KeelsonValidationRegistry

`src/KeelsonValidationRegistry.sol` implements the reads and events of the ERC-8004 Validation registry (v2.0.0) over the official Identity registry, with the `VerdictVerifier` as the validator of every entry:

- `recordCountersign(countersign, sigs)`: the request hash is the countersign's EIP-712 digest, checked through the `VerdictVerifier` (`tdx ‖ nitro`, tag `"2of2"`; or `tdx` alone, tag `"degraded"`). An ALLOW needs the coverage the vault locked under the countersign's request id for the same agent and amount, with the same signature mode, and responds `100`. A DENY responds `0` and needs the operator's request: the agent owner's or agent wallet's EIP-712 `ValidationRequest(bytes32 requestHash)` under the registry's domain `{Keelson, 1, chainId, registry}`, so nobody can pin denials on an agent whose operator did not ask. A DENY first recorded from the TDX signature alone becomes `"2of2"` when both signatures arrive. The response hash is the countersign's `evalHash`; the request URI serves the 66-byte typed-data payload.
- `recordOutcome(coverageId)`: moves an ALLOW's validation to its coverage's outcome, read from the vault as the reporter reads it: `100`/`"settled"` or `0`/`"slashed"`. Anyone may call it, once.

Deviation from the ERC: the request is not sent by the agent's owner and the response is not sent by the validator address. Both are proven by signatures instead (the operator's, which `lockCoverage` required for an ALLOW and the `ValidationRequest` carries for a DENY, and the legs'), so recording is permissionless and gasless for every party. The legs' signers must still be active when a countersign is recorded, so a validation is recorded right after its coverage is locked. The registry has no `validationRequest`/`validationResponse` for third parties, since a request hash chosen by anyone could claim a countersign's digest before it is recorded.

`script/DeployErc8004.s.sol` deploys both at their CREATE3 addresses.

## Verification

`.github/workflows/contracts-verify.yml` checks every property below three ways, and keeps the three apart. **Proven** means the Certora Prover verified the rule for every input and every reachable state, with `rule_sanity: basic` passing and each rule's `satisfy` twin reachable. Only these rows are formally verified. **Bounded** means Halmos 0.3.3 (`--loop 3`, signatures of 65 and 130 bytes) or `forge test --symbolic` found no counterexample within those bounds. That is evidence, not a proof. **Fuzzed** means the Foundry invariant handler (256 runs × 100 calls) and Medusa (200,000 calls per pull request, 2,000,000 nightly) found no violation on an Arbitrum Sepolia fork with real PYUSD, real Paxos `freeze` and `pause`, and coverages locked from real passkey and countersign vectors.

`script/verification-report.sh <results>` regenerates the table from a run's results. A Certora cell is ✅ only when each rule and its `satisfy` twin are verified; `seeded:<bug>` means the Prover reports that rule violated once the guard is removed. A check run by both symbolic engines must pass in both.

<!-- verification:start -->
| Id   | Property                                                                                                                               | Proven (Certora, unbounded)                                                               | Bounded (Halmos; forge `--symbolic`)                                   | Fuzzed (fork, real PYUSD)                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| I1   | A slash succeeds only with a valid, unexpired verdict signed 2-of-2 by active signers, or by the active TDX signer alone (then queued) | ✅ `slashRequiresValidVerdict`                                                            | ✅ `check_slashRequiresSignatures`                                     | ✅ `invariant_noUnsignedSlash` (256 × 100)     |
| I2   | A dispute settles at most once across slash, slashBatched, executeSlash and payWarranty                                                | ✅ `settledIsPermanent`, `noDoubleSettle`, `queuedImpliesSettled`, `seeded:double-settle` | ✅ `check_noDoubleSettle`                                              | ✅ `invariant_settledUnique` (256 × 100)       |
| I3   | slashed[c] + warranted[c] never exceeds the coverage amount                                                                            | ⏳ `slashedWithinCoverage`, `warrantyWithinCoverage`                                      | ✅ `check_slashWithinCoverage`, `check_slashAndWarrantyWithinCoverage` | ✅ `invariant_slashWithinCoverage` (256 × 100) |
| I4   | Σ(free + locked + queued) + Σclaimable ≤ PYUSD.balanceOf(vault)                                                                        | ✅ `conservation`                                                                         | —                                                                      | ✅ `invariant_conservation` (256 × 100)        |
| I5   | No withdrawal completes before readyAt or while a slash of its agent is pending                                                        | ✅ `noEarlyWithdrawal`                                                                    | ✅ `check_completeWithdrawalGuards`                                    | ✅ `invariant_noEarlyWithdrawal` (256 × 100)   |
| I6   | Withdrawals are requested only by the agent's owner or wallet and pay only the signed `to`                                             | ✅ `withdrawalPaysSignedTo`                                                               | —                                                                      | ✅ `invariant_withdrawalRecipient` (256 × 100) |
| I7   | A slash pays payoutAddress[payee] (or payee) exactly the amount, or credits exactly that to its claimable                              | ✅ `slashPaysPayeeExactly`                                                                | ✅ `check_slashPaysPayee`                                              | ✅ `invariant_payeeDelta` (256 × 100)          |
| I8   | Signer, measurement and issuer changes happen only through the AccessManager role (timelock)                                           | ❌ `registryChangesNeedAuthority`                                                         | —                                                                      | —                                              |
| I9   | PYUSD leaves the vault only to a withdrawal's `to`, a verdict's recipient, a claimant's `to` or the reserve                            | ✅ `outflowsOnlyToEntitled`                                                               | —                                                                      | ✅ `invariant_outflowsEntitled` (256 × 100)    |
| I10  | No external call happens while the vault's reentrancy lock is open                                                                     | ⏳ `externalCallsHoldLock`, `seeded:reentrancy`                                           | —                                                                      | —                                              |
| I11  | A reverting or frozen PYUSD leaves the payout claimable and I4 intact                                                                  | ❌ `failedPayoutIsClaimable`, `conservation@BondVaultRevertingToken`                      | —                                                                      | ✅ `invariant_conservation` (256 × 100)        |
| I12  | Every Slashed event carries the digest of the verified verdict                                                                         | —                                                                                         | ✅ `check_slashedCarriesDigest`                                        | ✅ `invariant_slashedDigest` (256 × 100)       |
| LIA  | slash only if liable == 1; payWarranty only if liable == 2                                                                             | ✅ `slashOnlyOperatorLiable`, `warrantyOnlyKeelsonLiable`, `seeded:any-liable`            | ✅ `check_liable`, `check_warrantySingleUse`                           | ✅ `invariant_liable` (256 × 100)              |
| DEG1 | A lone Nitro signature never locks coverage nor slashes                                                                                | ✅ `degradedOnlyTdx`                                                                      | ✅ `check_degradedOnlyTdx`                                             | ✅ `invariant_degradedTdxOnly` (256 × 100)     |
| DEG2 | A degraded coverage or verdict never pays instantly; its slash waits ≥ 72 h                                                            | ✅ `degradedNeverInstant`, `seeded:degraded-instant`                                      | ✅ `check_degradedQueued`                                              | ✅ `invariant_degradedQueued` (256 × 100)      |
| SIG1 | verify2of2 ⇒ the active TDX signer and the active, distinct Nitro signer, under allowed measurements                                   | ❌ `verify2of2Sound`                                                                      | ✅ `check_verify2of2`, `check_verify2of2Disallowed`                    | —                                              |
| SIG2 | Revocation is permanent                                                                                                                | ❌ `revocationPermanent`                                                                  | —                                                                      | —                                              |
| SIG3 | No signer becomes active except through a registration function                                                                        | ✅ `activeOnlyViaRegistration`                                                            | —                                                                      | —                                              |
| SIG4 | verifyDegraded accepts only an active TDX signer                                                                                       | ✅ `verifyDegradedTdxOnly`                                                                | —                                                                      | —                                              |
| ANC1 | latest[o].size strictly increases                                                                                                      | ✅ `sizeStrictlyIncreases`                                                                | —                                                                      | —                                              |
| ANC2 | rootAt[o][s] is written at most once                                                                                                   | ❌ `rootWrittenOnce`                                                                      | —                                                                      | —                                              |
| ANC3 | No anchor without verify2of2; every anchored root is consistent with the previous one                                                  | ⏳ `anchorRequires2of2`, `anchorChecksConsistency`, `seeded:anchor-rewrite`               | ✅ `check_rfc6962Consistency`                                          | —                                              |
| RSV1 | payWarranty is single use per dispute and 2-of-2 only                                                                                  | ✅ `warrantySingleUse`                                                                    | ✅ `check_warrantySingleUse`                                           | —                                              |
| RSV2 | Reserve shares are redeemed only inside the cooldown window                                                                            | ✅ `reserveCooldown`                                                                      | ✅ `check_reserveCooldown`                                             | —                                              |
| VAL1 | A countersign is recorded only after a passing VerdictVerifier check, each request once                                                | ❌ `recordRequiresVerifier`, `requestOnce`, `validationIsPermanent`                       | —                                                                      | —                                              |
| VAL2 | An ALLOW record implies a vault coverage with the same agentId                                                                         | ✅ `allowImpliesCoverage`                                                                 | —                                                                      | —                                              |
| VAL3 | Registries never block the vault: the vault calls none, and a reverting Reputation registry leaves the coverage unrated, not stuck     | ⏳ `vaultCallsNoRegistry`, `reputationNeverBlocks`, `seeded:reentrancy`                   | —                                                                      | —                                              |

| Mutation (`forge test --mutate`) | Score  | Survived |
| -------------------------------- | ------ | -------- |
| `KeelsonReputationReporter`      | 100.0% | 0        |
| `KeelsonReserve`                 | 100.0% | 0        |
| `KeelsonValidationRegistry`      | 100.0% | 0        |
| `VerdictVerifier`                | 100.0% | 0        |
<!-- verification:end -->

### What runs where

| Job           | Tool                                                                                                                                         | When                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `static`      | Slither 0.11.6 (fails on high or medium), Aderyn 0.6.8 (fails on high)                                                                       | every pull request and push                                     |
| `symbolic`    | Halmos 0.3.3 and `forge test --symbolic` (z3 5.3.3) over `test/symbolic/`                                                                    | every pull request and push                                     |
| `invariant`   | `test/invariant/`: the Keelson handler and `Properties`, and a16z's `ERC4626Test` on `KeelsonReserve`                                        | every pull request and push                                     |
| `medusa`      | Medusa 1.5.1 on `MedusaKeelson`, which calls the same `Properties`                                                                           | every pull request and push; 2,000,000 calls nightly            |
| `certora`     | Certora Prover, one job per `certora/conf/*.conf`, after `script/check-harness.sh`; the latest results are pinned in `verification/certora/` | on dispatch (the free plan allows 2,120 Prover minutes a month) |
| `seeded-bugs` | `script/seeded.sh`: each removed guard must produce a counterexample                                                                         | every pull request and push                                     |
| `smtchecker`  | solc's model checker (CHC, z3), one contract per job                                                                                         | nightly                                                         |
| `mutation`    | `forge test --mutate`, one contract per job, gated at 90% by `script/mutation-gate.sh`                                                       | nightly                                                         |

### Try it

```sh
script/seeded.sh double-settle halmos      # deletes the settled check, prints Halmos's counterexample, restores the source
script/seeded.sh any-liable certora        # deletes the liable == operator check; the Prover reports slashOnlyOperatorLiable violated
script/seeded.sh degraded-instant halmos   # lets a degraded verdict pay at once
script/seeded.sh anchor-rewrite forge      # anchors a rewritten history once the consistency check is gone
script/seeded.sh reentrancy certora        # drops nonReentrant from completeWithdrawal and pays before updating state
```

Each patch in `certora/seeded/` removes one guard from `src/`: it deletes a check, or for `reentrancy` drops `nonReentrant` and moves the transfer ahead of the state update. The script refuses to run on a modified `src/` and always reverts the patch.

### Assumptions and what is not covered

- Certora, Halmos and `forge --symbolic` cannot fork a chain. They use OpenZeppelin's `ERC20` as the token. For I11, the Prover uses a token whose `transfer` and `transferFrom` may revert or return false, which is how a Paxos freeze or pause looks to the vault.
- No TEE signs a `Verdict` yet. On the forks, verdicts are signed by two keys written into the `VerdictVerifier`'s signer records with `vm.store` (`test/utils/VerdictSigners.sol`). The Prover and Halmos model them through `ecrecover`.
- `lockCoverage` verifies a P-256 passkey assertion, which symbolic engines do not execute. The symbolic checks therefore start from coverages, bonds and an anchored root written at their storage slots as `lockCoverage` and `anchor` leave them (the checks read neither `coverageHash` nor the anchor's latest size). The fork suites lock coverages through `lockCoverage` itself.
- Medusa's EVM has no P256VERIFY precompile at `0x100`. `MedusaKeelson` etches one there that computes EIP-7951 with OpenZeppelin's `P256.verifySolidity`, and only when the address does not answer. Medusa has no log cheatcodes, so it checks I12 through the stored digests of queued slashes; Foundry checks every `Slashed` event.
- The fuzzers fork Arbitrum Sepolia at block 327,231,200, where the `VerdictVerifier` and `CheckpointAnchor` already exist, and deploy the vault and reserve at their real CREATE3 addresses.
- Halmos 0.3.3 models the SHA-256 precompile with an argument width in bytes rather than bits, so it cannot execute RFC 6962 hashing. The consistency check is bounded with `forge --symbolic` (trees of up to 16 leaves), and the Prover treats `RFC6962.verifyConsistency` as a function it does not open.
- Forge's symbolic engine does not sign symbolic digests. It runs the checks whose signatures are concrete; the rest are bounded by Halmos alone.
- Halmos computes `vm.addr` as an uninterpreted function, so `test/symbolic/SymbolicSetup.sol` pins the signers to their real addresses and uses constant addresses for the merchant and staker.
- Slither and Aderyn do not see the token call OpenZeppelin's `SafeERC20` makes in assembly. Their reentrancy detectors are no evidence for I10; the Prover's `CALL` hook is.
- The vault calls no reputation or validation registry. `KeelsonReputationReporter` and `KeelsonValidationRegistry` read it, permissionlessly. VAL3 is stated for that design.
- The Prover compiles the production sources with solc 0.8.38, `via_ir`, 200 runs and `prague`, but with the Yul optimizer's default step sequence minus the inliner (certora-cli 8.20.3 needs an explicit sequence for 0.8.38) and with evmasm's `deduplicate` and `cse` passes off, so that it can locate the internal functions it summarizes. The source and compiler match production; the bytecode does not exactly. `script/check-harness.sh` keeps every other setting equal to `[profile.default]`.
- Each Certora summary and `require` is justified in its spec:
  - `PasskeyAssertion.verify` and `MerkleProof.verifyCalldata` may return anything: no vault property depends on WebAuthn or on the batch leaf proof.
  - The Identity registry, ERC-1271 wallets and the AccessManager (`ownerOf`, `getAgentWallet`, `isValidSignature`, `canCall`, `consumeScheduledOp`) return arbitrary values, so any owner is possible, the vault included.
  - `receiveWithAuthorization` is a transfer from `from` to the caller. `permit` may do anything, since the vault ignores its outcome; the deposit that follows holds for any allowance.
  - Two balances of the token never exceed its total supply (OpenZeppelin `ERC20`), and the vault's allowance to itself is zero: it never approves and has no ERC-1271.
  - A payout's recipient is not the vault itself.
  - At `lockCoverage`, `slashed` and `warranted` of the new coverage id are zero. `warranted` is backed by `warrantyOnlyForHeldCoverage`; `slashed` is the accepted batch-leaf finding below.
  - The reverting-token conf lets every `transfer` and `transferFrom` revert; otherwise they run OpenZeppelin's `ERC20`.
  - `VerdictVerifier`: Automata's DCAP (on-chain and RISC Zero), the `NitroValidator` and `ArbSys` return arbitrary values, and so do `DstackEvents.replay`, `TdxOutput.parse`, `NitroDocument.read` and `tdxMeasurement`. The rules prove what registration requires of their outputs, not that the attestation verifiers are correct. `AccessManaged._checkCanCall` approves or reverts nondeterministically. Attestation fields are assumed to hash within 224 bytes (`optimistic_hashing`); real ones are 32 to 64.
  - `CheckpointAnchor`: `_noteStates` returns any result, and `RFC6962.verifyConsistency` is an uninterpreted predicate of its sizes and roots. The rule proves that the stored root passed the check, and the check itself is bounded with `forge --symbolic`. `keccak256(signedNote)`, which only feeds the event, is hashed optimistically.
  - `KeelsonValidationRegistry`: `_hex` returns any 66-character string. Loops are unrolled optimistically, because the only ones are copies of four literal tags of at most 8 bytes.
  - `KeelsonReputationReporter`: `feedbackURI` returns any 106-character string, and `giveFeedback` always reverts. `unratedSlashes` stays below `2^256 - 1`, since it grows by at most one per coverage.
- Rules the Prover has not closed yet are marked ❌ in the table, and the free plan's monthly quota is spent until 2026-12-01:
  - I11 is not proven. `failedPayoutIsClaimable` passes, but its `satisfy` twin is unreachable, so with the reverting-token summary no failed transfer may ever reach the vault's claimable branch: the rule may hold vacuously. The fork suites exercise that branch with real `freeze` and `pause`.
  - I3: the Prover checks `slashed + warranted <= amount` across the vault's functions. The reserve's `payWarranty` step (`warrantyWithinCoverage`) is still to write, and Halmos bounds the combined case.
  - I10 and VAL3 rest on a `CALL` hook. The reentrancy seed, which shows that hook catches the token call, has not yet run on the Prover.
  - `rootWrittenOnce` fails from a pre-state in which a root exists above the latest anchored size, a state no call creates. It needs a supporting invariant.
  - `verify2of2Sound` fails because `address(0)` could be admitted as a signer (finding below).
  - `revocationPermanent` and `registryChangesNeedAuthority` hold for every function except `registerSignerWithNitro`, where a loop is not yet summarized.
  - `signerMeasurementConsistent` fails from a pre-state in which measurement id 0 is allowed, which no call creates (ids start at 1). The supporting invariant `noAllowedIdZero` is written but not yet run.
  - `validationIsPermanent` and the twins of `requestOnce` and `validationIsPermanent` are open: a view loop (`getSummary`), and reachability.

### Accepted findings

The contracts are deployed and immutable, so accepted findings are recorded beside them instead of in the source.

- Slither: `slither.db.json`, Slither's triage database.
  - `arbitrary-send-erc20` in `depositWithPermit`: `owner` must be the agent's owner or wallet, and the tokens go to that agent's bond.
  - `unused-return` (four): `tryRecover`'s error code (the zero address already means failure), `outcomeOf`'s agent id, and `toUint64`, which is called only for its range check.
  - `incorrect-equality` on `last.size == 0`: intended.
  - `reentrancy-no-eth` in `rateCoverage`: `rated` is set before the call, and the call goes to the official registry with a fixed gas stipend.
- Aderyn: `verification/aderyn-accepted.json`. It covers `contract-locks-ether` (all of `msg.value` goes to Automata) and `reentrancy-state-change` after view calls, which compile to `STATICCALL`.
- Model checker: `verification/smt-accepted.txt`. Every unproved target is listed with the guard that excludes it.
- Signer registry (Low): `_admit` does not reject `signer == address(0)`. If an attestation with an allowed measurement bound key zero, every malformed or high-s signature would recover to an active signer. This is not reachable without an allowed enclave binding that key.
- Batch leaves (Low): `lockCoverage` accepts a coverage id that `slashBatched` already slashed as a batch leaf. That id's `slashed` then exceeds the new coverage, its release underflows, and its funds stay locked. This needs the operator and both TEE legs to sign a reused request id, which the legs are required to refuse.
- ERC-4626 (Low): `KeelsonReserve` does not override `maxDeposit` and `maxMint`, so they return the maximum even for a receiver whose cooldown runs, whose deposit then reverts with `CooldownActive`. No funds are at risk.
- Surviving mutants: `verification/survivors.md`.

## Pause

The Guardian can pause new coverage and veto a queued slash. Neither moves funds: there is no admin path that moves bonded PYUSD or the reserve's.

## Gas budgets

Every measured path asserts its gas against `budgets.json` through `test/utils/GasBudget.sol` and records the value in `snapshots/budgets.json`. CI fails when a path exceeds its budget or when the recorded values differ from the commit, so a change in gas shows up in review. Execution gas is the isolated transaction minus the intrinsic 21,000 and the EIP-2028 calldata; `_tx` entries are whole-transaction gas. Fork tests run on Arbitrum Sepolia at the block pinned in `deployments/421614.json`.

Where a path cannot meet its design target without changing a deployed contract, its budget is its measured value, so it can only go down.

| Path                                                             | Target                 | Budget                 | Measured                    |
| ---------------------------------------------------------------- | ---------------------- | ---------------------- | --------------------------- |
| `CheckpointAnchor.anchor`, 20-node proof                         | 80,000                 | 80,000                 | 77,546                      |
| `lockCoverage`, 2-of-2 WebAuthn / 2-of-2 SPC / degraded          | 180,000                | 180,000                | 166,833 / 167,350 / 158,951 |
| `lockCoverageBatch`, per coverage of 100                         | 2,000                  | 2,000                  | 1,320                       |
| `releaseCoverage`                                                | 50,000                 | 50,000                 | 17,115                      |
| `depositWithAuthorization`, first / later deposit                | 80,000                 | 117,434 / 83,234       | 117,434 / 83,234            |
| `depositWithPermit`, first deposit                               | 80,000                 | 140,037                | 140,037                     |
| `requestWithdrawal`, first / later                               | 80,000                 | 140,211 / 106,011      | 140,211 / 106,011           |
| `completeWithdrawal`, new / known recipient                      | 60,000                 | 67,254 / 60,000        | 67,254 / 50,154             |
| `slash`, instant: first ever / later                             | 120,000                | 195,353 / 144,053      | 195,353 / 144,053           |
| `slash`, queued                                                  | 110,000                | 232,769                | 232,769                     |
| `executeSlash` / `vetoSlash`                                     | 80,000 / 40,000        | 133,901 / 43,566       | 133,901 / 43,566            |
| `slashBatched`, 100-leaf batch                                   | 130,000                | 221,032                | 221,032                     |
| `payWarranty`                                                    | 110,000                | 176,011                | 176,011                     |
| `claim` (signed)                                                 | 60,000                 | 83,676                 | 83,676                      |
| `verify2of2` / `verifyDegraded`, cold                            | 12,000 / 7,000         | 16,854 / 8,708         | 16,854 / 8,708              |
| `recordCountersign` 2-of-2 / degraded, transaction               | 200,000 / 195,000      | 288,651 / 279,516      | 288,651 / 279,516           |
| `recordOutcome`, transaction                                     | —                      | 76,199                 | 76,199                      |
| `rateCoverage` first / later feedback, transaction               | —                      | 267,221 / 185,377      | 267,221 / 185,377           |
| Nitro leaf certificate cache / attestation document, transaction | 8,000,000 / 16,000,000 | 8,000,000 / 16,000,000 | 6,034,801 / 13,243,089      |

Why the misses stand:

- Deposits: PYUSD's `receiveWithAuthorization` costs about 45k by itself, and a first deposit writes the agent's bond and PYUSD's authorization slot from zero. The `ownerOf` check that refuses deposits to unminted agents adds 10.7k.
- Withdrawals: a request stores a two-slot `Withdrawal` and moves `queued` from zero; a payout to a new recipient writes its first PYUSD balance.
- Slashes and the warranty: a slash writes `settled`, `slashed`, the rate-limit bucket and `slashCount`, cross-checks the reserve, and pays the merchant (a first PYUSD balance costs about 17k). A queued slash stores the whole `QueuedSlash`, so `executeSlash` needs no calldata and still emits `Slashed`. `vetoSlash` misses by 3.6k.
- Signer checks: `verify2of2` reads two signer records and recovers two signatures; the target assumed one cold record read.
- `recordCountersign` writes four fresh `ValidationStatus` slots, the two ERC-8004 lookup arrays and `requestOf`. Packing the status into two slots (validator implied, tag as an enum, `uint64` agent id) measured 244,490 / 235,378, which is 15% less, and would make DENYs of agent ids at or above 2^64 revert.
- `rateCoverage` spends 221,645 of its gas in the ERC-8004 Reputation registry's `giveFeedback` (first feedback from a client, cold); the reporter's own share is under 46k.

## Sizes and storage

`forge build --sizes`, Foundry 1.9.0, solc 0.8.38 (EIP-170 runtime limit 24,576 B, EIP-3860 initcode limit 49,152 B).

| Contract                  | Runtime (B) | Margin (B) | Initcode (B) | Margin (B) |
| ------------------------- | ----------- | ---------- | ------------ | ---------- |
| KeelsonBondVault          | 24,338      | 238        | 25,884       | 23,268     |
| VerdictVerifier           | 14,354      | 10,222     | 15,569       | 33,583     |
| KeelsonReserve            | 11,542      | 13,034     | 13,603       | 35,549     |
| KeelsonValidationRegistry | 8,513       | 16,063     | 9,188        | 39,964     |
| CheckpointAnchor          | 3,976       | 20,600     | 4,110        | 45,042     |
| KeelsonReputationReporter | 2,635       | 21,941     | 2,812        | 46,340     |
| KeelsonDeployer           | 757         | 23,819     | 890          | 48,262     |

`KeelsonBondVault` is 238 B under the limit: anything new that reads the vault lives in its own contract, as the ERC-8004 reporter and validation registry do.

Storage slots per struct (`forge inspect <C> storageLayout`); `test/budgets/Layout.fork.t.sol` reads the packed words after a real deposit, lock and anchor.

| Struct                                       | Slots | Packing                                                                                                           |
| -------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- |
| `Bond`                                       | 2     | `free`, `locked` · `queued`, `slashCount`                                                                         |
| `CoverageState`                              | 1     | `amount`, `agentId`, `releaseAfter`, `status`, `degraded`, `pendingSlashes`; the coverage hash in its own mapping |
| `BatchState`                                 | 1     | `locked`, `agentId`, `releaseAfter`, `status`                                                                     |
| `Params`                                     | 1     | the four windows and `instantSlashCap`                                                                            |
| `Withdrawal`                                 | 2     | `amount`, `agentId`, `readyAt` · `to`                                                                             |
| `QueuedSlash`                                | 6     | four `bytes32` fields, `payee`+`amount`, `agentId`+`readyAt`+`fieldId`+`status`                                   |
| `VerdictVerifier.Record`                     | 2     | `teeKind`, `registeredAt`, `expiresAt`, `revokedAt`, `measurementId` · `measurement`                              |
| `CheckpointAnchor.Anchor`                    | 1     | `size`, `anchoredAt`; roots in `rootAt`                                                                           |
| `KeelsonValidationRegistry.ValidationStatus` | 4     | `validatorAddress`, `response`, `lastUpdate` · `agentId` · `responseHash` · `tag` (the ERC's reference layout)    |

## Operations

### Environments

| Chain                       | What it is                                                                                                             | Keelson contracts                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Arbitrum Sepolia (421614)   | Testnet. Test PYUSD from Paxos' faucet; demo windows (10 min disputes, 2 min veto, 15 min withdrawals, 5 min timelock) | All, verified on Arbiscan and Sourcify                                             |
| Ethereum Sepolia (11155111) | Testnet address mirror                                                                                                 | Governance, `KeelsonValidationRegistry`, `KeelsonReputationReporter`               |
| Arbitrum One (42161)        | Real PYUSD. Unaudited; small amounts only; no coverage of live purchases                                               | None deployed; the registry and fork tests are ready and every address is the same |

External dependencies:

| Dependency                                                      | Arbitrum Sepolia                                                                                                                         | Arbitrum One                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| PYUSD (upgradeable, pausable, freezable by its asset protector) | `0x637A1259C6afd7E3AdF63993cA7E58BB438aB1B1`                                                                                             | `0x46850aD61C2B7d64d08c9C754F45254596696984` |
| ERC-8004 Identity registry (v2.0.0, Draft)                      | `0x8004A818BFB912233c491871b3d84c89A494BD9e`                                                                                             | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 Reputation registry                                    | `0x8004B663056A597Dffe9eCcC1965A193B7388713`                                                                                             | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Automata DCAP attestation                                       | `0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F`                                                                                             | `0xaDdeC7e85c2182202b66E331f2a4A0bBB2cEEa1F` |
| `nitro-validator` (CertManager, P384Verifier, NitroValidator)   | `0x5FE55991F66f8bA97f005Ae46017FAf4FF802600`, `0x6fb8c2c0173425b8747900948E50d1f7A7baB3A2`, `0x3F09DAc4C09620329a0b292AF54B6f03378Fd74B` | not deployed                                 |
| P256VERIFY (RIP-7212)                                           | `0x0000000000000000000000000000000000000100`                                                                                             | `0x0000000000000000000000000000000000000100` |

### Runbook

Set `RPC` to the chain's RPC URL. Calls through the AccessManager need the caller's role; timelocked ones are scheduled on the TimelockController and executed after its delay.

- **Refill a relayer.** `GET https://api.keelson.finance/status` lists each relayer's address and balance; it reports `degraded` under the floor (0.01 ETH on Arbitrum Sepolia, 0.0005 ETH on Arbitrum One). Send ETH to the address.
- **Rotate a relayer KMS key.** Create an `ECC_SECG_P256K1` / `SIGN_VERIFY` key, add its ARN to the `keelson-relayer` user's policy (`kms:Sign` with `ECDSA_SHA_256` and `DIGEST`, `kms:GetPublicKey`), move the alias with `aws kms update-alias --alias-name alias/keelson-relayer-<chain> --target-key-id <id>`, and restart the API. The relayer derives its address from the public key: fund it, then let the old address drain and schedule the old key's deletion.
- **Rotate a TEE measurement.** Schedule `VerdictVerifier.setAllowedMeasurement(<measurement>, true)` on the timelock, execute it after the timelock and the `SIGNERS_ROLE` delay, register the new legs, then disallow the old measurement with `disallowMeasurement` from the Guardian Safe (no delay).
- **Re-register signers.** Registrations last 72 h. The API renews a leg's registration when it admits the leg within the renewal margin; check with `cast call $VERIFIER "signers(address)" <signer> --rpc-url $RPC`.
- **Pause new coverage.** From the Guardian Safe (2 of 3 owners), call `KeelsonBondVault.pause()`. Deposits, releases, slashes, claims and withdrawals keep working; `unpause()` restores locking.
- **Anchor now.** `POST /<origin>/anchor` on the log's private listener anchors the latest checkpoint.
- **Read state.** `cast call $VAULT "coverages(bytes32)((uint96,uint64,uint40,uint8,bool,uint8))" <coverageId> --rpc-url $RPC`, `cast call $VAULT "bonds(uint256)((uint128,uint128,uint128,uint64))" <agentId> --rpc-url $RPC`, `cast call $VAULT "slashed(bytes32)(uint96)" <coverageId> --rpc-url $RPC`, `cast call $ANCHOR "latest(bytes32)(uint64,bytes32,uint40)" $(cast keccak <origin>) --rpc-url $RPC`.

`script/arb-cost.sh` prices transactions already sent on Arbitrum Sepolia as they would cost on Arbitrum One: it replays each one's calldata through NodeInterface's `gasEstimateL1Component` and uses Arbitrum One's gas price and Chainlink's ETH/USD.
