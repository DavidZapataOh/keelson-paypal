// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CoverageVector, Vector} from "../script/CoverageVector.sol";
import {DeployMandateViolationCourt} from "../script/DeployMandateViolationCourt.s.sol";
import {MandateViolationCourt} from "../src/MandateViolationCourt.sol";
import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
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

    /// @dev A purchase the live legs countersigned and the live vault covers complied with its mandate: no proof of any
    /// violation class fits it, so the deployed court cannot convict it.
    function test_ALiveCompliantPurchaseCannotBeConvicted() public {
        string memory json = _jsonOf(421614);
        if (!vm.keyExistsJson(json, ".contracts.MandateViolationCourt")) return;
        vm.createSelectFork(vm.envString(json.readString(".rpcEnv")));
        MandateViolationCourt court = MandateViolationCourt(json.readAddress(".contracts.MandateViolationCourt"));
        Vector memory v = CoverageVector.read(
            vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/coverage-live.json")),
            json.readAddress(".demo.merchant"),
            uint40(json.readUint(".params.disputeWindow"))
        );
        assertEq(court.vault().coverageHash(v.coverage.coverageId), KeelsonTypes.hash(v.coverage), "locked live");
        string[5] memory classes = ["amount", "currency", "category", "expiry", "merchant"];
        for (uint8 code = 1; code <= 5; ++code) {
            string memory p =
                vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c2a-", classes[code - 1], ".json"));
            vm.expectRevert(MandateViolationCourt.InvalidProof.selector);
            court.proveViolation(v.coverage, v.countersign, v.hSd, v.countersigs, code, p.readBytes(".proof"));
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
