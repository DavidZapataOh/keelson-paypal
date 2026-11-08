// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title KeelsonTypes
/// @notice The EIP-712 messages the TEE legs sign, and their struct hashes. They are signed under the
/// `VerdictVerifier`'s domain `{name: "Keelson", version: "1", chainId, verifyingContract: VerdictVerifier}`.
library KeelsonTypes {
    struct Countersign {
        bytes32 requestId;
        bytes32 mandateHash;
        bytes32 mandateCommitment;
        bytes32 cartHash;
        uint256 agentId;
        bytes32 merchantId;
        uint64 amount;
        uint16 currency;
        uint8 category;
        bytes32 evidenceRoot;
        bytes32 evalHash;
        bytes32 policySetHash;
        uint8 decision;
        uint32 failedFieldsMask;
        uint40 issuedAt;
        uint40 expiresAt;
    }

    struct Verdict {
        bytes32 disputeId;
        bytes32 coverageId;
        uint256 agentId;
        address payee;
        uint96 amount;
        uint8 ruleId;
        uint8 liable;
        uint8 fieldId;
        bytes32 evidenceHash;
        bytes32 inputsHash;
        bytes32 policySetHash;
        bytes32 checkpointRoot;
        uint40 issuedAt;
        uint40 deadline;
    }

    struct Checkpoint {
        bytes32 origin;
        uint64 treeSize;
        bytes32 rootHash;
    }

    bytes32 internal constant COUNTERSIGN_TYPEHASH = keccak256(
        "Countersign(bytes32 requestId,bytes32 mandateHash,bytes32 mandateCommitment,bytes32 cartHash,uint256 agentId,"
        "bytes32 merchantId,uint64 amount,uint16 currency,uint8 category,bytes32 evidenceRoot,bytes32 evalHash,"
        "bytes32 policySetHash,uint8 decision,uint32 failedFieldsMask,uint40 issuedAt,uint40 expiresAt)"
    );

    bytes32 internal constant VERDICT_TYPEHASH = keccak256(
        "Verdict(bytes32 disputeId,bytes32 coverageId,uint256 agentId,address payee,uint96 amount,uint8 ruleId,"
        "uint8 liable,uint8 fieldId,bytes32 evidenceHash,bytes32 inputsHash,bytes32 policySetHash,"
        "bytes32 checkpointRoot,uint40 issuedAt,uint40 deadline)"
    );

    bytes32 internal constant CHECKPOINT_TYPEHASH =
        keccak256("Checkpoint(bytes32 origin,uint64 treeSize,bytes32 rootHash)");

    /// @dev Every member is a static type, so the encoding is the typehash followed by the struct's ABI encoding.
    function hash(Countersign memory c) internal pure returns (bytes32) {
        return keccak256(abi.encode(COUNTERSIGN_TYPEHASH, c));
    }

    function hash(Verdict memory v) internal pure returns (bytes32) {
        return keccak256(abi.encode(VERDICT_TYPEHASH, v));
    }

    function hash(Checkpoint memory c) internal pure returns (bytes32) {
        return keccak256(abi.encode(CHECKPOINT_TYPEHASH, c));
    }
}
