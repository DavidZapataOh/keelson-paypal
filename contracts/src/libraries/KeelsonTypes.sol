// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title KeelsonTypes
/// @notice The EIP-712 messages of Keelson and their struct hashes. The TEE legs sign `Countersign`, `Verdict` and
/// `Checkpoint` under the `VerdictVerifier`'s domain `{name: "Keelson", version: "1", chainId, verifyingContract:
/// VerdictVerifier}`; operators, owners and merchants sign the others under the `KeelsonBondVault`'s.
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

    /// @notice An operator's promise to cover one purchase. `amount` and `premium` are PYUSD base units.
    struct Coverage {
        bytes32 coverageId;
        uint256 agentId;
        address merchant;
        uint96 amount;
        uint96 premium;
        uint40 expiresAt;
        bytes32 mandateHash;
        bytes32 amberCommitment;
    }

    /// @notice Coverage for many purchases at once: `root` is the OpenZeppelin standard Merkle tree (leaf encoding
    /// `["bytes32"]`) of their `Coverage` struct hashes, all logged by `treeSize` in the checkpoint `checkpointRoot`.
    struct CoverageBatch {
        uint256 agentId;
        bytes32 root;
        uint128 total;
        uint96 premium;
        uint40 expiresAt;
        bytes32 checkpointRoot;
        uint64 treeSize;
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

    bytes32 internal constant COVERAGE_TYPEHASH = keccak256(
        "Coverage(bytes32 coverageId,uint256 agentId,address merchant,uint96 amount,uint96 premium,uint40 expiresAt,"
        "bytes32 mandateHash,bytes32 amberCommitment)"
    );

    bytes32 internal constant COVERAGE_BATCH_TYPEHASH = keccak256(
        "CoverageBatch(uint256 agentId,bytes32 root,uint128 total,uint96 premium,uint40 expiresAt,"
        "bytes32 checkpointRoot,uint64 treeSize)"
    );

    bytes32 internal constant WITHDRAWAL_REQUEST_TYPEHASH =
        keccak256("WithdrawalRequest(uint256 agentId,uint128 amount,address to,uint256 nonce,uint256 deadline)");

    bytes32 internal constant PAYOUT_ADDRESS_TYPEHASH =
        keccak256("PayoutAddress(address merchant,address payout,uint256 nonce,uint256 deadline)");

    bytes32 internal constant CLAIM_TYPEHASH =
        keccak256("Claim(address account,address to,uint256 nonce,uint256 deadline)");

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

    function hash(Coverage memory c) internal pure returns (bytes32) {
        return keccak256(abi.encode(COVERAGE_TYPEHASH, c));
    }

    function hash(CoverageBatch memory b) internal pure returns (bytes32) {
        return keccak256(abi.encode(COVERAGE_BATCH_TYPEHASH, b));
    }

    function hashWithdrawal(uint256 agentId, uint128 amount, address to, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(WITHDRAWAL_REQUEST_TYPEHASH, agentId, amount, to, nonce, deadline));
    }

    function hashPayoutAddress(address merchant, address payout, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(PAYOUT_ADDRESS_TYPEHASH, merchant, payout, nonce, deadline));
    }

    function hashClaim(address account, address to, uint256 nonce, uint256 deadline) internal pure returns (bytes32) {
        return keccak256(abi.encode(CLAIM_TYPEHASH, account, to, nonce, deadline));
    }
}
