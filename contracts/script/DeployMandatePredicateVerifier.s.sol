// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {HonkVerifierDeploy} from "./HonkVerifierDeploy.sol";

/// @notice Deploys the C1 `mandate_predicate` verifiers, which merchants call.
contract DeployMandatePredicateVerifier is HonkVerifierDeploy {
    string internal constant PREFIX = "MandatePredicate";

    function run() external returns (address verifier, address reference_) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        (verifier, reference_) = _deployVerifiers(PREFIX);
        vm.stopBroadcast();
    }

    /// @notice The reference verifier's creation code, linked to the libraries at their CREATE3 addresses.
    function referenceCode() public view returns (bytes memory) {
        return _referenceCode(PREFIX);
    }
}
