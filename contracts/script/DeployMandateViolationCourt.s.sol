// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ICoveredVault, IMandateViolationVerifier, MandateViolationCourt} from "../src/MandateViolationCourt.sol";
import {IVerdictVerifier} from "../src/interfaces/IVerdictVerifier.sol";
import {HonkVerifierDeploy} from "./HonkVerifierDeploy.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys the C2a `mandate_violation` verifiers and the `MandateViolationCourt` that uses the optimized one,
/// over the `KeelsonBondVault` and `VerdictVerifier` of the current contracts release. The court has no roles to wire.
contract DeployMandateViolationCourt is HonkVerifierDeploy {
    using stdJson for string;

    string internal constant PREFIX = "MandateViolation";
    string internal constant COURT = "MandateViolationCourt";

    function run() external returns (MandateViolationCourt court) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        // The verifiers are recorded once: their libraries' registry names nest under the reference verifier's.
        address verifier = predict(_verifier(PREFIX));
        if (verifier.code.length == 0) (verifier,) = _deployVerifiers(PREFIX);
        court = MandateViolationCourt(
            _deploy(versioned(COURT), type(MandateViolationCourt).creationCode, courtArgs(verifier))
        );
        vm.stopBroadcast();
    }

    function courtArgs(address verifier) public view returns (bytes memory) {
        return abi.encode(
            ICoveredVault(predict(versioned("KeelsonBondVault"))),
            IVerdictVerifier(predict(versioned("VerdictVerifier"))),
            IMandateViolationVerifier(verifier)
        );
    }

    /// @notice The reference verifier's creation code, linked to the libraries at their CREATE3 addresses.
    function referenceCode() public view returns (bytes memory) {
        return _referenceCode(PREFIX);
    }
}
