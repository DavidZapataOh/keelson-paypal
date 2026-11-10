// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys a circuit's bb verifiers at their CREATE3 addresses: the optimized Honk verifier, which callers use,
/// and the standard verifier as the reference path, linked to its two libraries. None has roles or constructor
/// arguments.
/// @dev bb names every verifier `HonkVerifier`; they are compiled without via-IR, so their code is read from the build
/// artifacts. `name` is the optimized verifier's file and registry name; the reference one adds `Reference`.
abstract contract HonkVerifierDeploy is KeelsonDeploy {
    using stdJson for string;

    function _deployVerifiers(string memory prefix) internal returns (address verifier, address reference_) {
        string memory ref = _reference(prefix);
        verifier = _deploy(_verifier(prefix), vm.getCode(string.concat(_verifier(prefix), ".sol:HonkVerifier")), "");
        _deploy(_library(ref, "RelationsLib"), vm.getCode(string.concat(ref, ".sol:RelationsLib")), "");
        _deploy(_library(ref, "ZKTranscriptLib"), vm.getCode(string.concat(ref, ".sol:ZKTranscriptLib")), "");
        reference_ = _deploy(ref, _referenceCode(prefix), "");
    }

    /// @notice The reference verifier's creation code, linked to the libraries at their CREATE3 addresses.
    function _referenceCode(string memory prefix) internal view returns (bytes memory) {
        string memory ref = _reference(prefix);
        string memory artifact = vm.readFile(string.concat(vm.projectRoot(), "/out/", ref, ".sol/HonkVerifier.json"));
        string memory code = artifact.readString(".bytecode.object");
        code = _link(code, ref, "RelationsLib");
        code = _link(code, ref, "ZKTranscriptLib");
        return vm.parseBytes(code);
    }

    function _verifier(string memory prefix) internal pure returns (string memory) {
        return string.concat(prefix, "Verifier");
    }

    function _reference(string memory prefix) internal pure returns (string memory) {
        return string.concat(prefix, "ReferenceVerifier");
    }

    function _library(string memory ref, string memory name) internal pure returns (string memory) {
        return string.concat(ref, ".", name);
    }

    /// @dev Replaces solc's placeholder, `__$`, the first 34 hex digits of keccak256 of the library's fully qualified
    /// name and `$__`, with its address.
    function _link(string memory code, string memory ref, string memory name) internal view returns (string memory) {
        bytes memory hash = bytes(vm.toString(keccak256(bytes(string.concat("src/verifiers/", ref, ".sol:", name)))));
        bytes memory digits = new bytes(34);
        for (uint256 i; i < 34; ++i) {
            digits[i] = hash[i + 2];
        }
        string memory addr = vm.replace(vm.toLowercase(vm.toString(predict(_library(ref, name)))), "0x", "");
        return vm.replace(code, string.concat("__$", string(digits), "$__"), addr);
    }
}
