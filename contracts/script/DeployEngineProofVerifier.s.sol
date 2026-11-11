// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {EngineProofVerifier} from "../src/EngineProofVerifier.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys the `EngineProofVerifier` over the chain's SP1 Groth16 verifier gateway, for the engine program's
/// verifying key in `test/vectors/engine-proof.json`.
/// @dev The verifier is immutable: a new program is recorded as `EngineProofVerifier` at the CREATE3 address of a new
/// `VERSION`, and the verifier of the earlier program keeps its own address and the proofs it recorded.
contract DeployEngineProofVerifier is KeelsonDeploy {
    using stdJson for string;

    string internal constant NAME = "EngineProofVerifier";
    /// @notice The program built in SP1's pinned image.
    string public constant VERSION = "EngineProofVerifier/4";

    function run() external returns (EngineProofVerifier verifier) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        verifier = EngineProofVerifier(_deployVersion(NAME, VERSION, type(EngineProofVerifier).creationCode, args()));
        vm.stopBroadcast();
    }

    function args() public view returns (bytes memory) {
        string memory proof = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/engine-proof.json"));
        return abi.encode(_registry().readAddress(".external.sp1VerifierGateway"), proof.readBytes32(".vkey"));
    }
}
