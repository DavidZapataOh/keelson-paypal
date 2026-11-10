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
        string[2] memory names = ["MandatePredicateVerifier", "MandatePredicateReferenceVerifier"];
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            string memory json = _jsonOf(CHAIN_IDS[i]);
            if (!vm.keyExistsJson(json, ".contracts.MandatePredicateVerifier")) continue;
            vm.createSelectFork(vm.envString(json.readString(".rpcEnv")));
            DeployMandatePredicateVerifier script = new DeployMandatePredicateVerifier();
            for (uint256 j; j < names.length; ++j) {
                address deployed = json.readAddress(string.concat(".contracts.", names[j]));
                assertEq(deployed, script.predict(names[j]));
                assertEq(deployed.code, deployCode(string.concat(names[j], ".sol:HonkVerifier")).code);
                assertTrue(IHonkVerifier(deployed).verify(proof, inputs));
            }
        }
    }
}
