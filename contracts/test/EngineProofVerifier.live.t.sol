// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployEngineProofVerifier} from "../script/DeployEngineProofVerifier.s.sol";
import {EngineProofVerifier} from "../src/EngineProofVerifier.sol";
import {ForkTest} from "./utils/Fork.sol";
import {SP1Verifier} from "@sp1-contracts/v6.1.0/SP1VerifierGroth16.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The deployed `EngineProofVerifier` on every chain whose registry lists it is this build over Succinct's
/// immutable SP1 v6.1.0 Groth16 verifier, never the gateway whose owner can change its routes, and accepts the engine
/// program's proof of the committed vector through it.
contract EngineProofVerifierLiveTest is ForkTest {
    using stdJson for string;

    function test_DeployedVerifierMatchesTheBuildAndVerifiesThroughTheV6_1_0Verifier() public {
        string memory v = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/engine-proof.json"));
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            string memory json = _jsonOf(CHAIN_IDS[i]);
            if (!vm.keyExistsJson(json, ".contracts.EngineProofVerifier")) continue;
            vm.createSelectFork(vm.envString(json.readString(".rpcEnv")));
            DeployEngineProofVerifier script = new DeployEngineProofVerifier();
            EngineProofVerifier verifier = EngineProofVerifier(json.readAddress(".contracts.EngineProofVerifier"));
            assertEq(address(verifier), script.predict(script.VERSION()));
            assertEq(address(verifier.VERIFIER()), json.readAddress(".external.sp1VerifierGroth16"));
            SP1Verifier pinned = new SP1Verifier();
            assertEq(SP1Verifier(address(verifier.VERIFIER())).VERIFIER_HASH(), pinned.VERIFIER_HASH());
            assertEq(SP1Verifier(address(verifier.VERIFIER())).VERSION(), pinned.VERSION());
            assertEq(verifier.PROGRAM_VKEY(), v.readBytes32(".vkey"));
            EngineProofVerifier fresh = new EngineProofVerifier(verifier.VERIFIER(), verifier.PROGRAM_VKEY());
            assertEq(address(verifier).code, address(fresh).code);
            (bytes32 evalHash, bytes32 digest) = verifier.verify(v.readBytes(".public_values"), v.readBytes(".proof"));
            assertEq(evalHash, v.readBytes32(".eval_hash"));
            assertEq(digest, v.readBytes32(".countersign_digest"));
        }
    }
}
