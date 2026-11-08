// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonBondVault} from "../src/KeelsonBondVault.sol";
import {KeelsonReputationReporter} from "../src/KeelsonReputationReporter.sol";
import {KeelsonValidationRegistry} from "../src/KeelsonValidationRegistry.sol";
import {IERC8004Identity} from "../src/interfaces/IERC8004Identity.sol";
import {IERC8004Reputation} from "../src/interfaces/IERC8004Reputation.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys `KeelsonValidationRegistry` and `KeelsonReputationReporter` at their CREATE3 addresses. Both read
/// the `KeelsonBondVault` at its CREATE3 address and the chain's official ERC-8004 registries. Idempotent. On a chain
/// where the vault is not deployed yet, both stay inert until it is.
/// @dev `forge script script/DeployErc8004.s.sol --rpc-url <chain> --account keelson-deployer --broadcast --slow`
contract DeployErc8004 is KeelsonDeploy {
    using stdJson for string;

    string internal constant VALIDATION = "KeelsonValidationRegistry";
    string internal constant REPORTER = "KeelsonReputationReporter";

    function run() external returns (KeelsonValidationRegistry validation, KeelsonReputationReporter reporter) {
        string memory json = _registry();
        bytes32 pinned = keccak256("2.0.0");
        require(
            keccak256(bytes(IERC8004Identity(json.readAddress(".external.erc8004Identity")).getVersion())) == pinned
                && keccak256(bytes(IERC8004Reputation(json.readAddress(".external.erc8004Reputation")).getVersion()))
                    == pinned,
            "ERC-8004 registries are not v2.0.0"
        );
        address vault = predict("KeelsonBondVault");
        require(
            vault.code.length == 0 || address(KeelsonBondVault(vault).verifier()) == predict("VerdictVerifier"),
            "vault bound to another VerdictVerifier"
        );
        vm.startBroadcast(_owner());
        _ensureDeployer();
        validation = KeelsonValidationRegistry(
            _deploy(VALIDATION, type(KeelsonValidationRegistry).creationCode, validationArgs())
        );
        reporter =
            KeelsonReputationReporter(_deploy(REPORTER, type(KeelsonReputationReporter).creationCode, reporterArgs()));
        vm.stopBroadcast();
    }

    /// @notice `(identity, verifier, vault)`: the official Identity registry, the `VerdictVerifier` and the
    /// `KeelsonBondVault`.
    function validationArgs() public view returns (bytes memory) {
        return abi.encode(
            _registry().readAddress(".external.erc8004Identity"),
            predict("VerdictVerifier"),
            predict("KeelsonBondVault")
        );
    }

    /// @notice `(vault, reputation)`: the `KeelsonBondVault` and the official Reputation registry.
    function reporterArgs() public view returns (bytes memory) {
        return abi.encode(predict("KeelsonBondVault"), _registry().readAddress(".external.erc8004Reputation"));
    }
}
