// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployEngineProofVerifier} from "../script/DeployEngineProofVerifier.s.sol";
import {EngineProofVerifier} from "../src/EngineProofVerifier.sol";
import {ForkTest} from "./utils/Fork.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The deployed `EngineProofVerifier` on every chain whose registry lists it is this build over the chain's
/// SP1 verifier gateway, and accepts the engine program's proof of the committed countersign vector through it.
contract EngineProofVerifierLiveTest is ForkTest {
    using stdJson for string;

    function test_DeployedVerifierMatchesTheBuildAndVerifiesThroughTheGateway() public {
        string memory v = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/engine-proof.json"));
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            string memory json = _jsonOf(CHAIN_IDS[i]);
            if (!vm.keyExistsJson(json, ".contracts.EngineProofVerifier")) continue;
            vm.createSelectFork(vm.envString(json.readString(".rpcEnv")));
            DeployEngineProofVerifier script = new DeployEngineProofVerifier();
            EngineProofVerifier verifier = EngineProofVerifier(json.readAddress(".contracts.EngineProofVerifier"));
            assertEq(address(verifier), script.predict("EngineProofVerifier"));
            assertEq(address(verifier.VERIFIER()), json.readAddress(".external.sp1VerifierGateway"));
            assertEq(verifier.PROGRAM_VKEY(), v.readBytes32(".vkey"));
            EngineProofVerifier fresh = new EngineProofVerifier(verifier.VERIFIER(), verifier.PROGRAM_VKEY());
            assertEq(address(verifier).code, address(fresh).code);
            (bytes32 evalHash, bytes32 digest) = verifier.verify(v.readBytes(".public_values"), v.readBytes(".proof"));
            assertEq(evalHash, v.readBytes32(".eval_hash"));
            assertEq(digest, v.readBytes32(".countersign_digest"));
        }
    }
}
