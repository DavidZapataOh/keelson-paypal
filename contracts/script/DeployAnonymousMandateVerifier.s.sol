// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {HonkVerifierDeploy} from "./HonkVerifierDeploy.sol";

/// @notice Deploys the C3 `anonymous_mandate` verifiers, which merchants call.
contract DeployAnonymousMandateVerifier is HonkVerifierDeploy {
    string internal constant PREFIX = "AnonymousMandate";

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
