// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {GasBudget} from "./utils/GasBudget.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";

interface IHonkVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

/// @notice The C1 `mandate_predicate` verifiers bb generated, optimized and reference, against a proof of the demo
/// mandate. They are compiled without via-IR, so they are deployed from their artifacts rather than imported.
contract MandatePredicateVerifierTest is Test {
    using stdJson for string;

    IHonkVerifier internal optimized;
    IHonkVerifier internal standard;
    bytes internal proof;
    bytes32[] internal inputs;

    function setUp() public {
        optimized = IHonkVerifier(deployCode("MandatePredicateVerifier.sol:HonkVerifier"));
        standard = IHonkVerifier(deployCode("MandatePredicateReferenceVerifier.sol:HonkVerifier"));
        string memory v = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c1-proof.json"));
        proof = v.readBytes(".proof");
        inputs = v.readBytes32Array(".publicInputs");
    }

    function test_gas_c1_verify() public {
        assertTrue(optimized.verify(proof, inputs));
        GasBudget.check("c1_verify", vm.lastCallGas().gasTotalUsed);
    }

    function test_gas_c1_verify_reference() public {
        assertTrue(standard.verify(proof, inputs));
        GasBudget.check("c1_verify_reference", vm.lastCallGas().gasTotalUsed);
    }

    function test_publicInputs_areTheEightOfTheStatement() public view {
        assertEq(inputs.length, 8);
        // amount 85.00, ISO 4217 840, category 21, operator 42: the demo cart.
        assertEq(uint256(inputs[1]), 8500);
        assertEq(uint256(inputs[2]), 840);
        assertEq(uint256(inputs[3]), 21);
        assertEq(uint256(inputs[7]), 42);
    }

    function test_anotherStatement_isRejected() public view {
        for (uint256 i; i < inputs.length; ++i) {
            bytes32[] memory other = inputs;
            other[i] = bytes32(uint256(other[i]) + 1);
            _assertRejected(optimized, proof, other);
            _assertRejected(standard, proof, other);
        }
    }

    function test_aTamperedProof_isRejected() public view {
        // One byte of every eighth 32-byte element, at a different position in each.
        for (uint256 offset = 31; offset < proof.length; offset += 8 * 32 + 1) {
            bytes memory bad = proof;
            bad[offset] = bad[offset] ^ 0x01;
            _assertRejected(optimized, bad, inputs);
            _assertRejected(standard, bad, inputs);
        }
    }

    function test_aShortInputList_isRejected() public view {
        bytes32[] memory short = new bytes32[](7);
        for (uint256 i; i < 7; ++i) {
            short[i] = inputs[i];
        }
        _assertRejected(optimized, proof, short);
        _assertRejected(standard, proof, short);
    }

    function _assertRejected(IHonkVerifier v, bytes memory p, bytes32[] memory pi) internal view {
        // The verifiers revert on malformed input and return false on a failed check: either way, no `true`.
        try v.verify(p, pi) returns (bool ok) {
            assertFalse(ok);
        } catch {}
    }
}
