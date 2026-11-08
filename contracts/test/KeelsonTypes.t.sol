// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {VerifierBase} from "./utils/VerifierBase.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The struct hashes match `packages/core/test/vectors/eip712.json`, which the TypeScript (viem) and Rust
/// (alloy) encoders are tested against, and the verifier's digests use its own domain.
contract KeelsonTypesTest is VerifierBase {
    using stdJson for string;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    string internal vectors;

    function setUp() public override {
        super.setUp();
        vectors = vm.readFile(string.concat(vm.projectRoot(), "/../packages/core/test/vectors/eip712.json"));
    }

    function _digest(string memory item, bytes32 structHash) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("Keelson"),
                keccak256("1"),
                vectors.readUint(string.concat(item, ".input.chainId")),
                vectors.readAddress(string.concat(item, ".input.verifyingContract"))
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _countersign(string memory m) internal view returns (KeelsonTypes.Countersign memory c) {
        c.requestId = vectors.readBytes32(string.concat(m, ".requestId"));
        c.mandateHash = vectors.readBytes32(string.concat(m, ".mandateHash"));
        c.mandateCommitment = vectors.readBytes32(string.concat(m, ".mandateCommitment"));
        c.cartHash = vectors.readBytes32(string.concat(m, ".cartHash"));
        c.agentId = vectors.readUint(string.concat(m, ".agentId"));
        c.merchantId = vectors.readBytes32(string.concat(m, ".merchantId"));
        c.amount = uint64(vectors.readUint(string.concat(m, ".amount")));
        c.currency = uint16(vectors.readUint(string.concat(m, ".currency")));
        c.category = uint8(vectors.readUint(string.concat(m, ".category")));
        c.evidenceRoot = vectors.readBytes32(string.concat(m, ".evidenceRoot"));
        c.evalHash = vectors.readBytes32(string.concat(m, ".evalHash"));
        c.policySetHash = vectors.readBytes32(string.concat(m, ".policySetHash"));
        c.decision = uint8(vectors.readUint(string.concat(m, ".decision")));
        c.failedFieldsMask = uint32(vectors.readUint(string.concat(m, ".failedFieldsMask")));
        c.issuedAt = uint40(vectors.readUint(string.concat(m, ".issuedAt")));
        c.expiresAt = uint40(vectors.readUint(string.concat(m, ".expiresAt")));
    }

    function _verdict(string memory m) internal view returns (KeelsonTypes.Verdict memory v) {
        v.disputeId = vectors.readBytes32(string.concat(m, ".disputeId"));
        v.coverageId = vectors.readBytes32(string.concat(m, ".coverageId"));
        v.agentId = vectors.readUint(string.concat(m, ".agentId"));
        v.payee = vectors.readAddress(string.concat(m, ".payee"));
        v.amount = uint96(vectors.readUint(string.concat(m, ".amount")));
        v.ruleId = uint8(vectors.readUint(string.concat(m, ".ruleId")));
        v.liable = uint8(vectors.readUint(string.concat(m, ".liable")));
        v.fieldId = uint8(vectors.readUint(string.concat(m, ".fieldId")));
        v.evidenceHash = vectors.readBytes32(string.concat(m, ".evidenceHash"));
        v.inputsHash = vectors.readBytes32(string.concat(m, ".inputsHash"));
        v.policySetHash = vectors.readBytes32(string.concat(m, ".policySetHash"));
        v.checkpointRoot = vectors.readBytes32(string.concat(m, ".checkpointRoot"));
        v.issuedAt = uint40(vectors.readUint(string.concat(m, ".issuedAt")));
        v.deadline = uint40(vectors.readUint(string.concat(m, ".deadline")));
    }

    function _checkpoint(string memory m) internal view returns (KeelsonTypes.Checkpoint memory c) {
        c.origin = vectors.readBytes32(string.concat(m, ".origin"));
        c.treeSize = uint64(vectors.readUint(string.concat(m, ".treeSize")));
        c.rootHash = vectors.readBytes32(string.concat(m, ".rootHash"));
    }

    function test_VectorsOfTeeSignedTypes() public view {
        uint256 checked;
        for (uint256 i;; ++i) {
            string memory item = string.concat("[", vm.toString(i), "]");
            if (!vm.keyExistsJson(vectors, item)) break;
            string memory primary = vectors.readString(string.concat(item, ".input.primaryType"));
            string memory m = string.concat(item, ".input.message");
            bytes32 structHash;
            if (keccak256(bytes(primary)) == keccak256("Countersign")) {
                structHash = KeelsonTypes.hash(_countersign(m));
            } else if (keccak256(bytes(primary)) == keccak256("Verdict")) {
                structHash = KeelsonTypes.hash(_verdict(m));
            } else if (keccak256(bytes(primary)) == keccak256("Checkpoint")) {
                structHash = KeelsonTypes.hash(_checkpoint(m));
            } else {
                continue;
            }
            assertEq(_digest(item, structHash), vectors.readBytes32(string.concat(item, ".expected")), item);
            ++checked;
        }
        assertEq(checked, 6);
    }

    function test_HashTypedDataUsesVerifierDomain() public view {
        bytes32 structHash = KeelsonTypes.hash(_checkpoint("[2].input.message"));
        bytes32 domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Keelson"), keccak256("1"), CHAIN_ID, address(verifier)));
        assertEq(verifier.hashTypedData(structHash), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }
}
