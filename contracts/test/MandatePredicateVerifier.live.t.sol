// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployMandatePredicateVerifier} from "../script/DeployMandatePredicateVerifier.s.sol";
import {IHonkVerifier} from "./MandatePredicateVerifier.t.sol";
import {ForkTest} from "./utils/Fork.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The deployed C1 verifiers on every chain whose registry lists them are this build, and accept the demo
/// proof in an `eth_call`, which is how a merchant checks one for free.
contract MandatePredicateVerifierLiveTest is ForkTest {
    using stdJson for string;

    function test_DeployedVerifiersMatchTheBuildAndVerify() public {
        string memory v = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c1-proof.json"));
        bytes memory proof = v.readBytes(".proof");
        bytes32[] memory inputs = v.readBytes32Array(".publicInputs");
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            string memory json = _jsonOf(CHAIN_IDS[i]);
            if (!vm.keyExistsJson(json, ".contracts.MandatePredicateVerifier")) continue;
            vm.createSelectFork(vm.envString(json.readString(".rpcEnv")));
            DeployMandatePredicateVerifier script = new DeployMandatePredicateVerifier();
            address verifier = json.readAddress(".contracts.MandatePredicateVerifier");
            address standard = json.readAddress(".contracts.MandatePredicateReferenceVerifier");
            assertEq(verifier, script.predict("MandatePredicateVerifier"));
            assertEq(standard, script.predict("MandatePredicateReferenceVerifier"));
            assertEq(verifier.code, vm.getDeployedCode("MandatePredicateVerifier.sol:HonkVerifier"));
            // Its immutables are set at construction: compare with this build deployed on the fork, linked the same.
            bytes memory init = script.referenceCode();
            address fresh;
            assembly ("memory-safe") {
                fresh := create(0, add(init, 0x20), mload(init))
            }
            assertEq(standard.code, fresh.code);
            assertTrue(IHonkVerifier(verifier).verify(proof, inputs));
            assertTrue(IHonkVerifier(standard).verify(proof, inputs));
        }
    }
}
