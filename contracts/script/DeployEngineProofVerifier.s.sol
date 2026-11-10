// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {EngineProofVerifier} from "../src/EngineProofVerifier.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys the `EngineProofVerifier` over the chain's SP1 Groth16 verifier gateway, for the engine program's
/// verifying key in `test/vectors/engine-proof.json`.
contract DeployEngineProofVerifier is KeelsonDeploy {
    using stdJson for string;

    string internal constant NAME = "EngineProofVerifier";

    function run() external returns (EngineProofVerifier verifier) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        verifier = EngineProofVerifier(_deploy(NAME, type(EngineProofVerifier).creationCode, args()));
        vm.stopBroadcast();
    }

    function args() public view returns (bytes memory) {
        string memory proof = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/engine-proof.json"));
        return abi.encode(_registry().readAddress(".external.sp1VerifierGateway"), proof.readBytes32(".vkey"));
    }
}
