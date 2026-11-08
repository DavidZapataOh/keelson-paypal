// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonTypes} from "../libraries/KeelsonTypes.sol";
import {PasskeyAssertion} from "../libraries/PasskeyAssertion.sol";

/// @title IKeelsonBondVault
/// @notice Holds each operator's PYUSD bond, indexed by its ERC-8004 `agentId`, and locks part of it as coverage for
/// each purchase the user approved with a passkey and both TEE legs countersigned.
interface IKeelsonBondVault {
    /// @notice Protocol windows in seconds, and the largest slash that executes without the veto window.
    struct Params {
        uint40 disputeWindow;
        uint40 vetoWindow;
        uint40 grace;
        uint40 withdrawalDelay;
        uint96 instantSlashCap;
    }

    /// @notice An agent's bond, in PYUSD base units: available, backing coverage, and waiting to be withdrawn.
    struct Bond {
        uint128 free;
        uint128 locked;
        uint128 queued;
        uint64 slashCount;
    }

    enum Status {
        None,
        Active,
        Released
    }

    /// @notice One coverage in one slot; the rest of the signed `Coverage` is in `CoverageLocked` and `coverageHash`.
    struct CoverageState {
        uint96 amount;
        uint64 agentId;
        uint40 releaseAfter;
        Status status;
        bool degraded;
        uint8 pendingSlashes;
    }

    struct BatchState {
        uint128 locked;
        uint64 agentId;
        uint40 releaseAfter;
        Status status;
    }

    struct Withdrawal {
        uint128 amount;
        uint64 agentId;
        uint40 readyAt;
        address to;
    }

    event BondDeposited(uint256 indexed agentId, address indexed from, uint256 amount);
    event ParamsSet(Params params);
    event CoverageLocked(
        bytes32 indexed coverageId,
        uint256 indexed agentId,
        address merchant,
        uint96 amount,
        uint96 premium,
        uint40 releaseAfter,
        bytes32 mandateHash,
        bytes32 amberCommitment,
        bytes32 countersignDigest,
        bytes32 userKeyHash,
        bool degraded
    );
    event PremiumPaid(bytes32 indexed coverageId, uint256 indexed agentId, uint96 premium);
    event CoverageReleased(bytes32 indexed coverageId, uint256 indexed agentId, uint96 amount);
    event WithdrawalQueued(uint256 indexed id, uint256 indexed agentId, uint128 amount, address to, uint40 readyAt);
    event WithdrawalCompleted(uint256 indexed id, uint128 paid);
    event PayoutAddressSet(address indexed merchant, address payout);
    event CoverageBatchLocked(
        bytes32 indexed batchId,
        uint256 indexed agentId,
        bytes32 root,
        uint128 total,
        uint96 premium,
        bytes32 checkpointRoot,
        uint64 treeSize
    );
    event CoverageBatchReleased(bytes32 indexed batchId, uint256 indexed agentId, uint128 amount);

    /// @notice The signer is neither the agent's ERC-8004 owner nor its agent wallet.
    error NotAgentAuthority();
    /// @notice The EIP-3009 authorization moved no tokens: PYUSD ignores a used nonce instead of reverting.
    error AuthorizationNotUsed();
    error InvalidParams();
    error CoverageExists();
    /// @notice The countersign does not allow this coverage: other request, agent, amount, currency or mandate.
    error CountersignMismatch();
    error Expired();
    /// @notice The coverage ends before the dispute window, counted from the countersign, closes.
    error WindowTooShort();
    error InvalidUserAssertion();
    error InvalidOperatorSignature();
    error InvalidCountersignature();
    error InsufficientBond();
    error NotReleasable();
    error NotReady();
    error SlashPending();
    error UnknownWithdrawal();
    error InvalidSignature();
    error BatchExists();
    error NotAnchored();
    error ZeroAmount();

    function depositWithAuthorization(
        uint256 agentId,
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 salt,
        bytes calldata signature
    ) external;

    function depositWithPermit(
        uint256 agentId,
        address owner,
        uint256 amount,
        uint256 deadline,
        bytes calldata signature
    ) external;

    /// @param hSd The hash of the mandate's selectively disclosable payload; with `cs.mandateCommitment` it gives the
    /// challenge the user's passkey signed.
    /// @param qx The user's P-256 public key, as disclosed in the mandate's `user.cred`.
    /// @param countersigs `tdx ‖ nitro` (130 bytes), or `tdx` alone (65 bytes) for a degraded purchase.
    function lockCoverage(
        KeelsonTypes.Coverage calldata c,
        KeelsonTypes.Countersign calldata cs,
        bytes32 hSd,
        PasskeyAssertion.Assertion calldata userAuth,
        bytes32 qx,
        bytes32 qy,
        bytes calldata operatorSig,
        bytes calldata countersigs
    ) external;

    function releaseCoverage(bytes32 coverageId) external;

    function requestWithdrawal(
        uint256 agentId,
        uint128 amount,
        address to,
        uint256 nonce,
        uint256 deadline,
        bytes calldata ownerSig
    ) external returns (uint256 id);

    function completeWithdrawal(uint256 id) external;

    function setPayoutAddress(
        address merchant,
        address payout,
        uint256 nonce,
        uint256 deadline,
        bytes calldata merchantSig
    ) external;

    function lockCoverageBatch(KeelsonTypes.CoverageBatch calldata b, bytes calldata operatorSig)
        external
        returns (bytes32 batchId);

    function releaseBatch(bytes32 batchId) external;

    function bonds(uint256 agentId) external view returns (Bond memory);

    function params() external view returns (Params memory);

    function coverages(bytes32 coverageId) external view returns (CoverageState memory);

    function batches(bytes32 batchId) external view returns (BatchState memory);

    function withdrawals(uint256 id) external view returns (Withdrawal memory);

    function domainSeparator() external view returns (bytes32);
}
