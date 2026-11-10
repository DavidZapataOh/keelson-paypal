// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IHonkVerifier} from "./MandatePredicateVerifier.t.sol";
import {GasBudget} from "./utils/GasBudget.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The C3 `anonymous_mandate` verifiers bb generated, optimized and reference, against a proof of the demo
/// mandate signed by a registered user through Secure Payment Confirmation and through plain WebAuthn.
contract AnonymousMandateVerifierTest is Test {
    using stdJson for string;

    /// @dev `sha256("keelson.finance")`, below the field modulus.
    bytes32 internal constant RP_ID_HASH = 0x1071caa839ec25d37b233c1d4b37fd3a9d1b0a09830e137e452105c07d6fc4f7;

    IHonkVerifier internal optimized;
    IHonkVerifier internal standard;

    function setUp() public {
        optimized = IHonkVerifier(deployCode("AnonymousMandateVerifier.sol:HonkVerifier"));
        standard = IHonkVerifier(deployCode("AnonymousMandateReferenceVerifier.sol:HonkVerifier"));
    }

    function test_eachAssertionType_verifies() public view {
        string[2] memory types = ["payment", "webauthn"];
        for (uint256 i; i < types.length; ++i) {
            (bytes memory proof, bytes32[] memory inputs) = _vector(types[i]);
            assertEq(inputs.length, 4);
            assertEq(inputs[3], RP_ID_HASH, "rp id hash");
            assertTrue(optimized.verify(proof, inputs), types[i]);
            assertTrue(standard.verify(proof, inputs), types[i]);
        }
    }

    function test_gas_c3_verify() public {
        (bytes memory proof, bytes32[] memory inputs) = _vector("payment");
        assertTrue(optimized.verify(proof, inputs));
        GasBudget.check("c3_verify", vm.lastCallGas().gasTotalUsed);
    }

    function test_anotherStatement_isRejected() public view {
        (bytes memory proof, bytes32[] memory inputs) = _vector("payment");
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
        (bytes memory proof, bytes32[] memory inputs) = _vector("webauthn");
        for (uint256 offset = 31; offset < proof.length; offset += 8 * 32 + 1) {
            bytes memory bad = bytes.concat(proof);
            bad[offset] = bad[offset] ^ 0x01;
            _assertRejected(optimized, bad, inputs);
            _assertRejected(standard, bad, inputs);
        }
    }

    function test_aShortInputList_isRejected() public view {
        (bytes memory proof, bytes32[] memory inputs) = _vector("payment");
        bytes32[] memory short = new bytes32[](3);
        for (uint256 i; i < 3; ++i) {
            short[i] = inputs[i];
        }
        _assertRejected(optimized, proof, short);
        _assertRejected(standard, proof, short);
    }

    function _vector(string memory name) internal view returns (bytes memory proof, bytes32[] memory inputs) {
        string memory v = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c3-", name, ".json"));
        proof = v.readBytes(".proof");
        inputs = v.readBytes32Array(".publicInputs");
    }

    function _assertRejected(IHonkVerifier v, bytes memory p, bytes32[] memory pi) internal view {
        try v.verify(p, pi) returns (bool ok) {
            assertFalse(ok);
        } catch {}
    }
}
