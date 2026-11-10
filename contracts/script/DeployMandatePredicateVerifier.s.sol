// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys the C1 `mandate_predicate` verifiers at their CREATE3 addresses: bb's optimized Honk verifier, which
/// merchants call, and its standard verifier as the reference path, linked to its two libraries. None has roles or
/// constructor arguments.
/// @dev The verifiers are compiled without via-IR, so their code is read from the build artifacts.
contract DeployMandatePredicateVerifier is KeelsonDeploy {
    using stdJson for string;

    string internal constant REFERENCE = "MandatePredicateReferenceVerifier";
    string internal constant REFERENCE_PATH = "src/verifiers/MandatePredicateReferenceVerifier.sol";

    function run() external returns (address verifier, address reference_) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        verifier = _deploy("MandatePredicateVerifier", vm.getCode("MandatePredicateVerifier.sol:HonkVerifier"), "");
        _deploy(_library("RelationsLib"), vm.getCode("MandatePredicateReferenceVerifier.sol:RelationsLib"), "");
        _deploy(_library("ZKTranscriptLib"), vm.getCode("MandatePredicateReferenceVerifier.sol:ZKTranscriptLib"), "");
        reference_ = _deploy(REFERENCE, referenceCode(), "");
        vm.stopBroadcast();
    }

    /// @notice The reference verifier's creation code, linked to the libraries at their CREATE3 addresses.
    function referenceCode() public view returns (bytes memory) {
        string memory artifact = vm.readFile(
            string.concat(vm.projectRoot(), "/out/MandatePredicateReferenceVerifier.sol/HonkVerifier.json")
        );
        string memory code = artifact.readString(".bytecode.object");
        code = _link(code, "RelationsLib");
        code = _link(code, "ZKTranscriptLib");
        return vm.parseBytes(code);
    }

    function _library(string memory name) internal pure returns (string memory) {
        return string.concat(REFERENCE, ".", name);
    }

    /// @dev Replaces solc's placeholder, `__$`, the first 34 hex digits of keccak256 of the library's fully qualified
    /// name and `$__`, with its address.
    function _link(string memory code, string memory name) internal view returns (string memory) {
        bytes memory hash = bytes(vm.toString(keccak256(bytes(string.concat(REFERENCE_PATH, ":", name)))));
        bytes memory digits = new bytes(34);
        for (uint256 i; i < 34; ++i) {
            digits[i] = hash[i + 2];
        }
        string memory addr = vm.replace(vm.toLowercase(vm.toString(predict(_library(name)))), "0x", "");
        return vm.replace(code, string.concat("__$", string(digits), "$__"), addr);
    }
}
