// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {console} from "forge-std/console.sol";

/// @notice Prints where each named contract lands; the addresses are identical on every chain.
/// @dev `forge script script/Predict.s.sol --chain-id 421614 --sig "run(string[])" '["VerdictVerifier","KeelsonBondVault"]'`
contract Predict is KeelsonDeploy {
    function run(string[] calldata names) external view {
        console.log("KeelsonDeployer", deployerAddress());
        for (uint256 i; i < names.length; ++i) {
            console.log(names[i], predict(names[i]));
        }
    }
}
