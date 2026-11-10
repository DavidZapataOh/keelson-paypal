// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonDeploy} from "./KeelsonDeploy.sol";

/// @notice Deploys the C1 `mandate_predicate` verifiers at their CREATE3 addresses: bb's optimized Honk verifier, which
/// merchants call, and its standard verifier as the reference path. Neither has roles or constructor arguments.
contract DeployMandatePredicateVerifier is KeelsonDeploy {
    function run() external returns (address verifier, address reference_) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        verifier = _deploy("MandatePredicateVerifier", vm.getCode("MandatePredicateVerifier.sol:HonkVerifier"), "");
        reference_ = _deploy(
            "MandatePredicateReferenceVerifier", vm.getCode("MandatePredicateReferenceVerifier.sol:HonkVerifier"), ""
        );
        vm.stopBroadcast();
    }
}
