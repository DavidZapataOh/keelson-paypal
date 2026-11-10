// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IHonkVerifier} from "./MandatePredicateVerifier.t.sol";
import {GasBudget} from "./utils/GasBudget.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The `anonymous_purchase` verifiers (C1 composed with C3) bb generated, optimized and reference, against a proof of the demo
/// mandate: an $85 cart that satisfies it, signed by a registered user.
contract AnonymousPurchaseVerifierTest is Test {
    using stdJson for string;

    IHonkVerifier internal optimized;
    IHonkVerifier internal standard;

    function setUp() public {
        optimized = IHonkVerifier(deployCode("AnonymousPurchaseVerifier.sol:HonkVerifier"));
        standard = IHonkVerifier(deployCode("AnonymousPurchaseReferenceVerifier.sol:HonkVerifier"));
    }

    function test_theDemoPurchase_verifies() public view {
        (bytes memory proof, bytes32[] memory inputs) = _vector();
        assertEq(inputs.length, 10);
        assertTrue(optimized.verify(proof, inputs));
        assertTrue(standard.verify(proof, inputs));
    }

    function test_gas_c1c3_verify() public {
        (bytes memory proof, bytes32[] memory inputs) = _vector();
        assertTrue(optimized.verify(proof, inputs));
        GasBudget.check("c1c3_verify", vm.lastCallGas().gasTotalUsed);
    }

    function test_anotherStatement_isRejected() public view {
        (bytes memory proof, bytes32[] memory inputs) = _vector();
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
        (bytes memory proof, bytes32[] memory inputs) = _vector();
        for (uint256 offset = 31; offset < proof.length; offset += 8 * 32 + 1) {
            bytes memory bad = bytes.concat(proof);
            bad[offset] = bad[offset] ^ 0x01;
            _assertRejected(optimized, bad, inputs);
            _assertRejected(standard, bad, inputs);
        }
    }

    function test_aShortInputList_isRejected() public view {
        (bytes memory proof, bytes32[] memory inputs) = _vector();
        bytes32[] memory short = new bytes32[](9);
        for (uint256 i; i < 9; ++i) {
            short[i] = inputs[i];
        }
        _assertRejected(optimized, proof, short);
        _assertRejected(standard, proof, short);
    }

    function _vector() internal view returns (bytes memory proof, bytes32[] memory inputs) {
        string memory v = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c1c3.json"));
        proof = v.readBytes(".proof");
        inputs = v.readBytes32Array(".publicInputs");
    }

    function _assertRejected(IHonkVerifier v, bytes memory p, bytes32[] memory pi) internal view {
        try v.verify(p, pi) returns (bool ok) {
            assertFalse(ok);
        } catch {}
    }
}
