// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {EngineProofVerifier} from "../src/EngineProofVerifier.sol";
import {GasBudget} from "./utils/GasBudget.sol";
import {ISP1Verifier} from "@sp1-contracts/ISP1Verifier.sol";
import {Verifier as Groth16Verifier} from "@sp1-contracts/v6.1.0/Groth16Verifier.sol";
import {SP1Verifier} from "@sp1-contracts/v6.1.0/SP1VerifierGroth16.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The engine proof verifier over Succinct's SP1 v6.1.0 Groth16 verifier, against a proof of the committed
/// countersign vector made by the engine's SP1 program.
contract EngineProofVerifierTest is Test {
    using stdJson for string;

    event EngineProven(bytes32 indexed countersignDigest, bytes32 evalHash, address indexed prover);

    EngineProofVerifier internal verifier;
    bytes internal publicValues;
    bytes internal proof;
    bytes32 internal evalHash;
    bytes32 internal digest;

    function setUp() public {
        string memory v = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/engine-proof.json"));
        publicValues = v.readBytes(".public_values");
        proof = v.readBytes(".proof");
        evalHash = v.readBytes32(".eval_hash");
        digest = v.readBytes32(".countersign_digest");
        verifier = new EngineProofVerifier(ISP1Verifier(address(new SP1Verifier())), v.readBytes32(".vkey"));
    }

    function test_verify_returnsTheEvalHashAndDigest() public view {
        (bytes32 e, bytes32 d) = verifier.verify(publicValues, proof);
        assertEq(e, evalHash);
        assertEq(d, digest);
    }

    function test_gas_engine_verify() public {
        verifier.verify(publicValues, proof);
        GasBudget.check("engine_verify", vm.lastCallGas().gasTotalUsed);
    }

    function test_gas_engine_record() public {
        vm.expectEmit(address(verifier));
        emit EngineProven(digest, evalHash, address(this));
        verifier.record(publicValues, proof);
        GasBudget.check("engine_record_tx", vm.lastCallGas().gasTotalUsed);
        assertEq(verifier.proven(digest), evalHash);
    }

    function test_record_once() public {
        verifier.record(publicValues, proof);
        vm.expectRevert(abi.encodeWithSelector(EngineProofVerifier.AlreadyProven.selector, digest));
        verifier.record(publicValues, proof);
    }

    function test_rejects_aChangedEvalHash() public {
        bytes memory changed = bytes.concat(bytes32(uint256(evalHash) ^ 1), digest);
        vm.expectRevert(Groth16Verifier.ProofInvalid.selector);
        verifier.verify(changed, proof);
    }

    function test_rejects_aChangedDigest() public {
        bytes memory changed = bytes.concat(evalHash, bytes32(uint256(digest) ^ 1));
        vm.expectRevert(Groth16Verifier.ProofInvalid.selector);
        verifier.record(changed, proof);
    }

    function test_rejects_aFlippedProofByte() public {
        bytes memory flipped = bytes.concat(proof);
        flipped[100] ^= 0x01;
        vm.expectRevert();
        verifier.verify(publicValues, flipped);
    }

    function test_rejects_anotherProgram() public {
        EngineProofVerifier other = new EngineProofVerifier(verifier.VERIFIER(), keccak256("another program"));
        vm.expectRevert();
        other.verify(publicValues, proof);
    }

    function test_rejects_publicValuesOfAnotherLength() public {
        vm.expectRevert(EngineProofVerifier.InvalidPublicValues.selector);
        verifier.verify(bytes.concat(publicValues, bytes1(0)), proof);
    }
}
