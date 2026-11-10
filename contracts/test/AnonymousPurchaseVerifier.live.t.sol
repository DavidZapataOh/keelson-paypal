// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployAnonymousPurchaseVerifier} from "../script/DeployAnonymousPurchaseVerifier.s.sol";
import {IHonkVerifier} from "./MandatePredicateVerifier.t.sol";
import {ForkTest} from "./utils/Fork.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The deployed composed verifiers on every chain whose registry lists them are this build, and accept a demo
/// proof in an `eth_call`, which is how a merchant checks one for free.
contract AnonymousPurchaseVerifierLiveTest is ForkTest {
    using stdJson for string;

    function test_DeployedVerifiersMatchTheBuildAndVerify() public {
        string memory v = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c1c3.json"));
        bytes memory proof = v.readBytes(".proof");
        bytes32[] memory inputs = v.readBytes32Array(".publicInputs");
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            string memory json = _jsonOf(CHAIN_IDS[i]);
            if (!vm.keyExistsJson(json, ".contracts.AnonymousPurchaseVerifier")) continue;
            vm.createSelectFork(vm.envString(json.readString(".rpcEnv")));
            DeployAnonymousPurchaseVerifier script = new DeployAnonymousPurchaseVerifier();
            address verifier = json.readAddress(".contracts.AnonymousPurchaseVerifier");
            address standard = json.readAddress(".contracts.AnonymousPurchaseReferenceVerifier");
            assertEq(verifier, script.predict("AnonymousPurchaseVerifier"));
            assertEq(standard, script.predict("AnonymousPurchaseReferenceVerifier"));
            assertEq(verifier.code, vm.getDeployedCode("AnonymousPurchaseVerifier.sol:HonkVerifier"));
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
