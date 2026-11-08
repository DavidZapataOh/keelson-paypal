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

    enum SlashStatus {
        None,
        Queued,
        Executed,
        Vetoed
    }

    /// @notice A slash waiting for its veto window. `batchId` is zero unless the coverage is part of a batch.
    struct QueuedSlash {
        bytes32 coverageId;
        bytes32 batchId;
        address payee;
        uint96 amount;
        uint64 agentId;
        uint40 readyAt;
        uint8 fieldId;
        SlashStatus status;
        bytes32 evidenceHash;
        bytes32 verdictDigest;
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
    /// @notice An operator's bond paid a merchant; `verdictDigest` is the EIP-712 digest the TEE legs signed.
    event Slashed(
        bytes32 indexed disputeId,
        bytes32 indexed coverageId,
        uint256 indexed agentId,
        address payee,
        uint96 amount,
        uint8 fieldId,
        bytes32 evidenceHash,
        bytes32 verdictDigest
    );
    event SlashQueued(
        bytes32 indexed disputeId,
        bytes32 indexed coverageId,
        uint256 indexed agentId,
        uint96 amount,
        uint40 readyAt,
        bool degraded,
        bytes32 verdictDigest
    );
    event SlashVetoed(bytes32 indexed disputeId, string reason);
    /// @notice The transfer to `recipient` failed (a frozen address, a paused token): the amount waits in `claimable`.
    event PayoutFailed(bytes32 indexed disputeId, address indexed recipient, uint96 amount);
    event Claimed(address indexed account, address to, uint256 amount);
    event RateLimitSet(uint48 window, uint208 capacity);

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
    error InvalidVerdictSignature();
    error NotOperatorLiable();
    /// @notice The dispute was already settled, by a slash or a warranty. On a retry it means done.
    error AlreadySettled();
    error CoverageNotActive();
    error ExceedsCoverage();
    error NotInBatch();
    error NotQueued();
    error VetoClosed();

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
    /// @param qx The user's P-256 public key, as disclosed in the mandate's `user.cred`; `keccak256(qx ‖ qy)` must be
    /// the `userKeyHash` the operator signed in `c`.
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

    /// @notice Pays `v.payee` (or its payout address) from the operator's bond on a verdict that names the operator
    /// liable, signed by both TEE legs (`sigs` = `tdx ‖ nitro`) or by the TDX leg alone (65 bytes), against a
    /// checkpoint anchored at `treeSize`. Large, degraded or rate-limited slashes wait in the veto window instead.
    function slash(KeelsonTypes.Verdict calldata v, uint64 treeSize, bytes calldata sigs) external;

    /// @notice `slash` for a coverage locked in a batch: `c` is the coverage and `proof` its Merkle proof in the batch.
    function slashBatched(
        KeelsonTypes.Verdict calldata v,
        uint64 treeSize,
        bytes calldata sigs,
        bytes32 batchId,
        KeelsonTypes.Coverage calldata c,
        bytes32[] calldata proof
    ) external;

    /// @notice Pays a queued slash once its veto window has passed. Permissionless.
    function executeSlash(bytes32 disputeId) external;

    /// @notice Cancels a queued slash inside its veto window. Moves no funds; the dispute stays settled.
    function vetoSlash(bytes32 disputeId, string calldata reason) external;

    /// @notice Pays all of `account`'s failed payouts to `to`. Gasless: anyone may submit `account`'s `Claim`
    /// signature; `sig` is ignored when `account` is the caller.
    function claim(address account, address to, uint256 nonce, uint256 deadline, bytes calldata sig) external;

    function setRateLimit(uint48 window, uint208 capacity) external;

    /// @notice PYUSD that slashes may still pay out now before the rate limit queues them.
    function rateLimitAvailable() external view returns (uint256);

    function settled(bytes32 disputeId) external view returns (bool);

    /// @notice Amount slashed from a coverage, queued slashes included.
    function slashed(bytes32 coverageId) external view returns (uint96);

    /// @notice Where a merchant's payouts go instead of its own address, if set.
    function payoutAddress(address merchant) external view returns (address);

    function claimable(address account) external view returns (uint256);

    function queuedSlashes(bytes32 disputeId) external view returns (QueuedSlash memory);

    function bonds(uint256 agentId) external view returns (Bond memory);

    function params() external view returns (Params memory);

    function coverages(bytes32 coverageId) external view returns (CoverageState memory);

    function batches(bytes32 batchId) external view returns (BatchState memory);

    function withdrawals(uint256 id) external view returns (Withdrawal memory);

    function domainSeparator() external view returns (bytes32);
}
