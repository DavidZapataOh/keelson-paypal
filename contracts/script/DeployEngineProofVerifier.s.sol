// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {EngineProofVerifier} from "../src/EngineProofVerifier.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys the `EngineProofVerifier` over Succinct's immutable SP1 v6.1.0 Groth16 verifier, never the gateway
/// whose owner can change its routes, for the engine program's verifying key in `test/vectors/engine-proof.json`.
/// @dev The verifier is immutable: a new program is recorded as `EngineProofVerifier` at the CREATE3 address of a new
/// `VERSION`, and the verifier of the earlier program keeps its own address and the proofs it recorded.
contract DeployEngineProofVerifier is KeelsonDeploy {
    using stdJson for string;

    string internal constant NAME = "EngineProofVerifier";
    /// @notice Over Succinct's immutable SP1 v6.1.0 Groth16 verifier.
    string public constant VERSION = "EngineProofVerifier/5";

    function run() external returns (EngineProofVerifier verifier) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        verifier = EngineProofVerifier(_deployVersion(NAME, VERSION, type(EngineProofVerifier).creationCode, args()));
        vm.stopBroadcast();
    }

    function args() public view returns (bytes memory) {
        string memory proof = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/engine-proof.json"));
        return abi.encode(_registry().readAddress(".external.sp1VerifierGroth16"), proof.readBytes32(".vkey"));
    }
}
