// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CheckpointAnchor} from "../src/CheckpointAnchor.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";

/// @notice Deploys the `CheckpointAnchor` at its CREATE3 address over the `VerdictVerifier`'s. It has no roles to wire.
contract DeployCheckpointAnchor is KeelsonDeploy {
    function run() external returns (CheckpointAnchor anchor) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        anchor = CheckpointAnchor(_deploy("CheckpointAnchor", type(CheckpointAnchor).creationCode, constructorArgs()));
        vm.stopBroadcast();
    }

    /// @notice `(verifier)`: the `VerdictVerifier`'s CREATE3 address.
    function constructorArgs() public view returns (bytes memory) {
        return abi.encode(predict("VerdictVerifier"));
    }
}
