# Keelson contracts

> **Unaudited.** These contracts have not been audited. Use them on testnets, or on Arbitrum One only with amounts you can afford to lose.

Foundry project for Keelson's on-chain layer: bonds, coverage, slashing, the warranty reserve, checkpoint anchoring and the signer registry. Solidity 0.8.38 (`evm_version = "prague"`, `via_ir`, 200 optimizer runs), OpenZeppelin Contracts 5.7.0, Foundry 1.9.0.

## Layout

| Path | Contents |
|---|---|
| `src/` | Contracts. `src/access/` roles, `src/deploy/` the deterministic deployer, `src/interfaces/`, `src/libraries/` |
| `test/` | `*.t.sol` local tests, `*.fork.t.sol` against forks pinned in the registry, `*.live.t.sol` against the live chains; `test/utils/` shared bases and fixtures |
| `script/` | Deploy, predict and verify scripts |
| `deployments/<chainId>.json` | Per-chain registry: inputs (RPC, fork block, external addresses, parameters, governance owners) and deployed addresses |

## Commands

```sh
forge build --sizes
forge test --no-match-path 'test/**/*.live.t.sol'   # local and fork tests
forge test --match-path 'test/**/*.live.t.sol'      # live chains
forge snapshot --check --no-match-path 'test/**/*.{fork,live}.t.sol'
```

Fork and live tests read `ARBITRUM_SEPOLIA_RPC_URL`, `ARBITRUM_ONE_RPC_URL` and `ETHEREUM_SEPOLIA_RPC_URL`. The public endpoints work: `https://sepolia-rollup.arbitrum.io/rpc`, `https://arb1.arbitrum.io/rpc`, `https://ethereum-sepolia-rpc.publicnode.com`.

## Deterministic addresses

`KeelsonDeployer` is created through the deterministic CREATE2 factory (`0x4e59b44847b379578588920cA78FbF26c0B4956C`) with salt zero and its owner as constructor argument, so it has the same address on every chain. It deploys every other contract with CREATE3 (OpenZeppelin `Create3`): an address depends only on the salt `keccak256("keelson/v1/<ContractName>")`, never on constructor arguments, so each chain passes its own token and parameters and still lands on the same address. Only the owner can deploy. Nothing is upgradeable; a fix ships by bumping the release string and redeploying.

Bytecode is compiled without the CBOR metadata hash, so a deterministic address never moves because of a comment or a remapping. Sourcify reports these contracts as `match` rather than `exact_match`.

## Pause

The Guardian can pause new coverage. Pausing never enables withdrawing funds: there is no admin path that moves bonded PYUSD.
