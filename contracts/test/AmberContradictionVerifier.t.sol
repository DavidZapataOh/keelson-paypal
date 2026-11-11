// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IHonkVerifier} from "./MandatePredicateVerifier.t.sol";
import {GasBudget} from "./utils/GasBudget.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The C2b `amber_contradiction` verifiers bb generated, optimized and reference, against a proof of each
/// amber field contradicted by the demo store's Tempo 3 in size 11.
contract AmberContradictionVerifierTest is Test {
    using stdJson for string;

    IHonkVerifier internal optimized;
    IHonkVerifier internal standard;

    function setUp() public {
        optimized = IHonkVerifier(deployCode("AmberContradictionVerifier.sol:HonkVerifier"));
        standard = IHonkVerifier(deployCode("AmberContradictionReferenceVerifier.sol:HonkVerifier"));
    }

    function test_eachField_verifies() public view {
        string[4] memory classes = ["size", "color", "unitPrice", "returnsFree"];
        for (uint256 i; i < classes.length; ++i) {
            (bytes memory proof, bytes32[] memory inputs) = _vector(classes[i]);
            assertEq(inputs.length, 5);
            assertEq(uint256(inputs[4]), i + 1, "field id");
            assertTrue(optimized.verify(proof, inputs), classes[i]);
            assertTrue(standard.verify(proof, inputs), classes[i]);
        }
    }

    function test_gas_c2b_verify() public {
        (bytes memory proof, bytes32[] memory inputs) = _vector("size");
        assertTrue(optimized.verify(proof, inputs));
        GasBudget.check("c2b_verify", vm.lastCallGas().gasTotalUsed);
    }

    function test_anotherStatement_isRejected() public view {
        (bytes memory proof, bytes32[] memory inputs) = _vector("size");
        for (uint256 i; i < inputs.length; ++i) {
            bytes32[] memory other = new bytes32[](inputs.length);
            for (uint256 j; j < inputs.length; ++j) {
                other[j] = inputs[j];
            }
            other[i] = bytes32(uint256(other[i]) + 1);
            _assertRejected(optimized, proof, other);
            _assertRejected(standard, proof, other);
        }
    }

    function test_aTamperedProof_isRejected() public view {
        (bytes memory proof, bytes32[] memory inputs) = _vector("color");
        for (uint256 offset = 31; offset < proof.length; offset += 8 * 32 + 1) {
            bytes memory bad = bytes.concat(proof);
            bad[offset] = bad[offset] ^ 0x01;
            _assertRejected(optimized, bad, inputs);
            _assertRejected(standard, bad, inputs);
        }
    }

    function _vector(string memory name) internal view returns (bytes memory proof, bytes32[] memory inputs) {
        string memory v = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c2b-", name, ".json"));
        proof = v.readBytes(".proof");
        inputs = v.readBytes32Array(".publicInputs");
    }

    function _assertRejected(IHonkVerifier v, bytes memory p, bytes32[] memory pi) internal view {
        try v.verify(p, pi) returns (bool ok) {
            assertFalse(ok);
        } catch {}
    }
}
