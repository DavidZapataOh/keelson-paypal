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

Fork and live tests read `ARBITRUM_SEPOLIA_RPC_URL`, `ARBITRUM_ONE_RPC_URL` and `ETHEREUM_SEPOLIA_RPC_URL`. The public endpoints work: `https://sepolia-rollup.arbitrum.io/rpc`, `https://arbitrum-one.public.blastapi.io` (archive state, which the pinned Arbitrum One fork needs), `https://ethereum-sepolia-rpc.publicnode.com`.

## Deterministic addresses

`KeelsonDeployer` is created through the deterministic CREATE2 factory (`0x4e59b44847b379578588920cA78FbF26c0B4956C`) with salt zero and its owner as constructor argument, so it has the same address on every chain. It deploys every other contract with CREATE3 (OpenZeppelin `Create3`): an address depends only on the salt `keccak256("keelson/v1/<ContractName>")`, never on constructor arguments, so each chain passes its own token and parameters and still lands on the same address. Only the owner can deploy. Nothing is upgradeable; a fix ships by bumping the release string and redeploying.

Bytecode is compiled without the CBOR metadata hash, so a deterministic address never moves because of a comment or a remapping. Sourcify reports these contracts as `match` rather than `exact_match`.

## Deployments

The same addresses on every chain. Arbitrum One has a registry (`deployments/42161.json`) and fork tests, and is not deployed yet.

| Contract           | Address                                      | Arbitrum Sepolia (421614)                                                                       | Sepolia (11155111)                                                                                |
| ------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| KeelsonDeployer    | `0x539638ee1C4021730f9fA63b725c7E9bA02b714A` | [Arbiscan](https://sepolia.arbiscan.io/address/0x539638ee1C4021730f9fA63b725c7E9bA02b714A#code) | [Etherscan](https://sepolia.etherscan.io/address/0x539638ee1C4021730f9fA63b725c7E9bA02b714A#code) |
| AccessManager      | `0x57c30a4a175978673bAD2B2B2D3667966cd58314` | [Arbiscan](https://sepolia.arbiscan.io/address/0x57c30a4a175978673bAD2B2B2D3667966cd58314#code) | [Etherscan](https://sepolia.etherscan.io/address/0x57c30a4a175978673bAD2B2B2D3667966cd58314#code) |
| TimelockController | `0xEDD241A9B8cf55765eDA7182483351555cf3E07e` | [Arbiscan](https://sepolia.arbiscan.io/address/0xEDD241A9B8cf55765eDA7182483351555cf3E07e#code) | [Etherscan](https://sepolia.etherscan.io/address/0xEDD241A9B8cf55765eDA7182483351555cf3E07e#code) |
| GuardianSafe       | `0x1cd0152d2d954Fc8c9436986C9F4B2C15903eF5C` | [Arbiscan](https://sepolia.arbiscan.io/address/0x1cd0152d2d954Fc8c9436986C9F4B2C15903eF5C#code) | [Etherscan](https://sepolia.etherscan.io/address/0x1cd0152d2d954Fc8c9436986C9F4B2C15903eF5C#code) |

Governance: the TimelockController (5 min delay on testnets, 48 h on Arbitrum One) is the only admin of the AccessManager. The Guardian Safe (2-of-3) holds `GUARDIAN_ROLE` and can cancel timelock operations. Signer rotation (`SIGNERS_ROLE`) waits for the timelock and then the AccessManager's execution delay. The deployer holds no role.

Deploy and verify a chain:

```sh
forge script script/Deploy.s.sol --rpc-url <arbitrum_sepolia|sepolia|arbitrum> \
  --account keelson-deployer --password "$DEPLOYER_KEYSTORE_PASSWORD" --broadcast --slow
script/verify.sh <chainId>
```

On Sepolia, pass `--gas-estimate-multiplier 200`: its node underestimates the hand-over transactions. `script/Predict.s.sol` prints where any contract name lands before it is deployed.

## Pause

The Guardian can pause new coverage. Pausing never enables withdrawing funds: there is no admin path that moves bonded PYUSD.
