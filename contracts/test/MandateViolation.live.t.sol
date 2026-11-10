// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployMandateViolationCourt} from "../script/DeployMandateViolationCourt.s.sol";
import {MandateViolationCourt} from "../src/MandateViolationCourt.sol";
import {IHonkVerifier} from "./MandatePredicateVerifier.t.sol";
import {ForkTest} from "./utils/Fork.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The deployed C2a verifiers and `MandateViolationCourt` on every chain whose registry lists them are this
/// build, wired to the registry's vault and `VerdictVerifier`, and the verifiers accept a proof of each class.
contract MandateViolationLiveTest is ForkTest {
    using stdJson for string;

    function test_DeployedCourtAndVerifiersMatchTheBuild() public {
        string[5] memory classes = ["amount", "currency", "category", "expiry", "merchant"];
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            string memory json = _jsonOf(CHAIN_IDS[i]);
            if (!vm.keyExistsJson(json, ".contracts.MandateViolationCourt")) continue;
            vm.createSelectFork(vm.envString(json.readString(".rpcEnv")));
            DeployMandateViolationCourt script = new DeployMandateViolationCourt();
            address verifier = json.readAddress(".contracts.MandateViolationVerifier");
            address standard = json.readAddress(".contracts.MandateViolationReferenceVerifier");
            MandateViolationCourt court = MandateViolationCourt(json.readAddress(".contracts.MandateViolationCourt"));
            assertEq(verifier, script.predict("MandateViolationVerifier"));
            assertEq(standard, script.predict("MandateViolationReferenceVerifier"));
            assertEq(address(court), script.predict("MandateViolationCourt"));
            assertEq(verifier.code, vm.getDeployedCode("MandateViolationVerifier.sol:HonkVerifier"));
            assertEq(standard.code, _created(script.referenceCode()).code);
            assertEq(
                address(court).code,
                _created(abi.encodePacked(type(MandateViolationCourt).creationCode, script.courtArgs(verifier))).code
            );
            assertEq(address(court.vault()), json.readAddress(".contracts.KeelsonBondVault"));
            assertEq(address(court.teeVerifier()), json.readAddress(".contracts.VerdictVerifier"));
            assertEq(address(court.proofVerifier()), verifier);
            for (uint256 k; k < classes.length; ++k) {
                string memory v =
                    vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c2a-", classes[k], ".json"));
                bytes memory proof = v.readBytes(".proof");
                bytes32[] memory inputs = v.readBytes32Array(".publicInputs");
                assertTrue(IHonkVerifier(verifier).verify(proof, inputs), classes[k]);
                assertTrue(IHonkVerifier(standard).verify(proof, inputs), classes[k]);
            }
        }
    }

    /// @dev Immutables are set at construction: compare with this build deployed on the fork.
    function _created(bytes memory init) internal returns (address fresh) {
        assembly ("memory-safe") {
            fresh := create(0, add(init, 0x20), mload(init))
        }
        assertTrue(fresh != address(0), "created");
    }
}
