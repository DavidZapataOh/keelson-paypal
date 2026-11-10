// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IConvictions} from "./interfaces/IConvictions.sol";
import {IERC8004Identity} from "./interfaces/IERC8004Identity.sol";
import {IKeelsonBondVault} from "./interfaces/IKeelsonBondVault.sol";
import {IPYUSD} from "./interfaces/IPYUSD.sol";
import {KeelsonTypes} from "./libraries/KeelsonTypes.sol";
import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice What the pool reads from the `KeelsonBondVault`.
interface IPoolVault {
    function coverageHash(bytes32 coverageId) external view returns (bytes32);
    function coverages(bytes32 coverageId) external view returns (IKeelsonBondVault.CoverageState memory);
    function payoutAddress(address merchant) external view returns (address);
    function params() external view returns (IKeelsonBondVault.Params memory);
}

/// @title ViolationBondPool
/// @notice A PYUSD deposit an operator posts, per ERC-8004 `agentId`, next to its `KeelsonBondVault` bond, which pays
/// the merchant of a coverage as soon as a listed court holds a conviction for it: no TEE and no Keelson signature in
/// the payout. Each coverage is paid once, its coverage amount capped by the operator's deposit, to the merchant's
/// payout address in the vault, or the merchant. Withdrawals wait at least the vault's own withdrawal delay, and what
/// is waiting stays payable until it leaves. Courts are listed by the admin (the timelock), and only add the ways a
/// violation can be proven; the payout path itself has no role.
contract ViolationBondPool is AccessManaged, ReentrancyGuardTransient {
    using SafeERC20 for IPYUSD;
    using SafeCast for uint256;

    struct Deposit {
        uint128 balance;
        /// @notice Requested out of `balance`, payable to violations until `completeWithdrawal`.
        uint128 withdrawing;
        uint40 unlockAt;
        address to;
    }

    IPYUSD public immutable pyusd;
    IPoolVault public immutable vault;
    IERC8004Identity public immutable identity;
    uint40 public immutable withdrawalDelay;

    mapping(address court => bool) public isCourt;
    mapping(uint256 agentId => Deposit) internal _deposits;
    /// @notice Whether a coverage's violation was paid, by any court.
    mapping(bytes32 coverageId => bool) public paid;
    /// @notice Payouts whose transfer failed (a frozen recipient), for the recipient to `claim`.
    mapping(address account => uint256) public claimable;

    event CourtSet(address indexed court, bool listed);
    event Deposited(uint256 indexed agentId, address indexed from, uint256 amount);
    event WithdrawalRequested(uint256 indexed agentId, address to, uint256 amount, uint40 unlockAt);
    event WithdrawalCompleted(uint256 indexed agentId, address to, uint256 amount);
    event ViolationPaid(
        bytes32 indexed coverageId,
        uint256 indexed agentId,
        address indexed court,
        address recipient,
        uint256 amount,
        uint8 code,
        bytes32 evidenceDigest
    );
    event PayoutFailed(bytes32 indexed coverageId, address indexed recipient, uint256 amount);
    event Claimed(address indexed account, address to, uint256 amount);

    error UnknownAgent();
    error NotAgentAuthority();
    error ZeroAmount();
    error ExceedsDeposit();
    error NotReady();
    error UnknownCourt();
    error AlreadyPaid();
    error NotCovered();
    error NotConvicted();
    /// @notice The conviction came after the coverage's dispute window closed.
    error ConvictedTooLate();
    error NoDeposit();
    error DelayTooShort();

    constructor(
        IPYUSD pyusd_,
        IPoolVault vault_,
        IERC8004Identity identity_,
        address authority,
        uint40 withdrawalDelay_,
        address[] memory courts
    ) AccessManaged(authority) {
        if (withdrawalDelay_ <= vault_.params().withdrawalDelay) revert DelayTooShort();
        pyusd = pyusd_;
        vault = vault_;
        identity = identity_;
        withdrawalDelay = withdrawalDelay_;
        for (uint256 i; i < courts.length; ++i) {
            _setCourt(courts[i], true);
        }
    }

    /// @notice Adds `amount` PYUSD, approved by the caller, to `agentId`'s deposit.
    function deposit(uint256 agentId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (identity.ownerOf(agentId) == address(0)) revert UnknownAgent();
        _deposits[agentId].balance += amount.toUint128();
        pyusd.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(agentId, msg.sender, amount);
    }

    /// @notice Asks for `amount` of the deposit to be paid to `to` after the delay; replaces an earlier request.
    /// @dev Only the agent's ERC-8004 owner or agent wallet.
    function requestWithdrawal(uint256 agentId, uint128 amount, address to) external {
        if (msg.sender != identity.ownerOf(agentId) && msg.sender != identity.getAgentWallet(agentId)) {
            revert NotAgentAuthority();
        }
        Deposit storage d = _deposits[agentId];
        if (amount == 0 || to == address(0)) revert ZeroAmount();
        if (amount > d.balance) revert ExceedsDeposit();
        uint40 unlockAt = (block.timestamp + withdrawalDelay).toUint40();
        (d.withdrawing, d.unlockAt, d.to) = (amount, unlockAt, to);
        emit WithdrawalRequested(agentId, to, amount, unlockAt);
    }

    /// @notice Pays a matured request, less what violations took meanwhile. Permissionless.
    function completeWithdrawal(uint256 agentId) external nonReentrant {
        Deposit storage d = _deposits[agentId];
        if (d.withdrawing == 0 || block.timestamp < d.unlockAt) revert NotReady();
        uint128 amount = d.withdrawing < d.balance ? d.withdrawing : d.balance;
        address to = d.to;
        d.balance -= amount;
        (d.withdrawing, d.unlockAt, d.to) = (0, 0, address(0));
        pyusd.safeTransfer(to, amount);
        emit WithdrawalCompleted(agentId, to, amount);
    }

    /// @notice Pays the merchant of coverage `c` from its operator's deposit, if `court` convicted it during the
    /// coverage's dispute window. Permissionless; once per coverage.
    /// @param c The `Coverage` the vault locked, as its `coverageHash` holds it.
    function payViolation(address court, KeelsonTypes.Coverage calldata c) external nonReentrant {
        if (!isCourt[court]) revert UnknownCourt();
        if (paid[c.coverageId]) revert AlreadyPaid();
        bytes32 locked = vault.coverageHash(c.coverageId);
        if (locked == 0 || locked != KeelsonTypes.hash(c)) revert NotCovered();
        (uint8 code, uint40 provenAt, bytes32 evidence) = IConvictions(court).violations(c.coverageId);
        if (code == 0) revert NotConvicted();
        if (provenAt > vault.coverages(c.coverageId).releaseAfter) revert ConvictedTooLate();
        Deposit storage d = _deposits[c.agentId];
        uint128 amount = c.amount < d.balance ? c.amount : d.balance;
        if (amount == 0) revert NoDeposit();

        paid[c.coverageId] = true;
        d.balance -= amount;
        address recipient = vault.payoutAddress(c.merchant);
        if (recipient == address(0)) recipient = c.merchant;
        if (!pyusd.trySafeTransfer(recipient, amount)) {
            claimable[recipient] += amount;
            emit PayoutFailed(c.coverageId, recipient, amount);
        }
        emit ViolationPaid(c.coverageId, c.agentId, court, recipient, amount, code, evidence);
    }

    /// @notice Pays the caller's failed payouts to `to`.
    function claim(address to) external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert ZeroAmount();
        claimable[msg.sender] = 0;
        pyusd.safeTransfer(to, amount);
        emit Claimed(msg.sender, to, amount);
    }

    /// @notice Lists or delists a court whose convictions the pool pays. Admin (timelock).
    function setCourt(address court, bool listed) external restricted {
        _setCourt(court, listed);
    }

    function deposits(uint256 agentId) external view returns (Deposit memory) {
        return _deposits[agentId];
    }

    function _setCourt(address court, bool listed) internal {
        isCourt[court] = listed;
        // forge-lint: disable-next-line(reentrancy-events)
        emit CourtSet(court, listed);
    }
}
