// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ICheckpointAnchor} from "./interfaces/ICheckpointAnchor.sol";
import {IKeelsonBondVault} from "./interfaces/IKeelsonBondVault.sol";
import {IKeelsonReserve} from "./interfaces/IKeelsonReserve.sol";
import {IVerdictVerifier} from "./interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "./libraries/KeelsonTypes.sol";
import {AccessManaged} from "@openzeppelin/contracts/access/manager/AccessManaged.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title KeelsonReserve
/// @notice Keelson's warranty pool: an ERC-4626 vault over PYUSD whose shares (`kwPYUSD`) earn every coverage premium
/// and pay the merchant when both TEE legs name Keelson liable. Withdrawals open only after a cooldown, so stakers cannot
/// leave ahead of a warranty they see coming. Not upgradeable.
/// @dev The virtual offset of 6 decimals is OpenZeppelin's mitigation of the first-depositor inflation attack. PYUSD
/// owed to payees whose transfers failed is excluded from `totalAssets`.
contract KeelsonReserve is IKeelsonReserve, ERC4626, AccessManaged, EIP712, Nonces, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint8 internal constant LIABLE_KEELSON = 2;
    uint256 internal constant TWO_SIGNATURES = 130;

    IVerdictVerifier public immutable verifier;
    ICheckpointAnchor public immutable anchor;
    IKeelsonBondVault public immutable vault;
    /// @notice `keccak256` of the origin of the log whose anchored checkpoints verdicts name.
    bytes32 public immutable logOrigin;

    uint40 public cooldown;
    uint40 public unstakeWindow;
    mapping(address owner => uint40) public cooldownStart;
    /// @inheritdoc IKeelsonReserve
    mapping(bytes32 disputeId => bool) public settled;
    /// @notice Warranties paid per coverage, never more than its amount.
    mapping(bytes32 coverageId => uint256) public warranted;
    /// @inheritdoc IKeelsonReserve
    mapping(address account => uint256) public claimable;
    /// @inheritdoc IKeelsonReserve
    uint256 public totalClaimable;

    constructor(
        IERC20 pyusd,
        IVerdictVerifier verifier_,
        ICheckpointAnchor anchor_,
        IKeelsonBondVault vault_,
        bytes32 logOrigin_,
        address authority,
        uint40 cooldown_,
        uint40 unstakeWindow_
    ) ERC20("Keelson Warranty Reserve", "kwPYUSD") ERC4626(pyusd) AccessManaged(authority) EIP712("Keelson", "1") {
        verifier = verifier_;
        anchor = anchor_;
        vault = vault_;
        logOrigin = logOrigin_;
        _setCooldown(cooldown_, unstakeWindow_);
    }

    /// @inheritdoc IKeelsonReserve
    /// @dev Only 2-of-2: a warranty is Keelson paying from its own pool and can wait for both legs. A warranty may come
    /// after the coverage was released: Keelson's guarantee runs for the dispute window, which the release already
    /// waited for.
    function payWarranty(KeelsonTypes.Verdict calldata v, uint64 treeSize, bytes calldata sigs) external nonReentrant {
        bytes32 digest = verifier.hashTypedData(KeelsonTypes.hash(v));
        if (sigs.length != TWO_SIGNATURES || !verifier.verify2of2(digest, sigs)) revert InvalidVerdictSignature();
        if (v.liable != LIABLE_KEELSON) revert NotKeelsonLiable();
        if (settled[v.disputeId] || vault.settled(v.disputeId)) revert AlreadySettled();
        if (block.timestamp > v.deadline) revert Expired();
        if (v.checkpointRoot == 0 || anchor.rootAt(logOrigin, treeSize) != v.checkpointRoot) revert NotAnchored();
        IKeelsonBondVault.CoverageState memory c = vault.coverages(v.coverageId);
        if (c.status == IKeelsonBondVault.Status.None || c.agentId != v.agentId) revert UnknownCoverage();
        if (v.amount > c.amount - warranted[v.coverageId]) revert ExceedsCoverage();
        if (v.amount > totalAssets()) revert InsufficientReserve();

        settled[v.disputeId] = true;
        warranted[v.coverageId] += v.amount;
        if (!IERC20(asset()).trySafeTransfer(v.payee, v.amount)) {
            claimable[v.payee] += v.amount;
            totalClaimable += v.amount;
            // forge-lint: disable-next-line(reentrancy-events)
            emit PayoutFailed(v.disputeId, v.payee, v.amount);
        }
        // forge-lint: disable-next-line(reentrancy-events)
        emit WarrantyPaid(v.disputeId, v.coverageId, v.payee, v.amount, digest);
    }

    /// @inheritdoc IKeelsonReserve
    function claim(address account, address to, uint256 nonce, uint256 deadline, bytes calldata sig)
        external
        nonReentrant
    {
        if (msg.sender != account) {
            if (block.timestamp > deadline) revert Expired();
            bytes32 digest = _hashTypedDataV4(KeelsonTypes.hashClaim(account, to, nonce, deadline));
            if (!SignatureChecker.isValidSignatureNowCalldata(account, digest, sig)) revert InvalidSignature();
            _useCheckedNonce(account, nonce);
        }
        uint256 amount = claimable[account];
        if (amount == 0) revert ZeroAmount();
        claimable[account] = 0;
        totalClaimable -= amount;
        IERC20(asset()).safeTransfer(to, amount);
        // forge-lint: disable-next-line(reentrancy-events)
        emit Claimed(account, to, amount);
    }

    /// @inheritdoc IKeelsonReserve
    function requestCooldown() external {
        uint40 start = SafeCast.toUint40(block.timestamp);
        cooldownStart[msg.sender] = start;
        emit CooldownRequested(msg.sender, start);
    }

    /// @inheritdoc IKeelsonReserve
    function setCooldown(uint40 cooldown_, uint40 unstakeWindow_) external restricted {
        _setCooldown(cooldown_, unstakeWindow_);
    }

    /// @notice PYUSD held for the stakers: the balance less what failed payouts wait to claim.
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) - totalClaimable;
    }

    /// @notice Zero outside the owner's withdrawal window `[start + cooldown, start + cooldown + unstakeWindow]`.
    /// @dev `maxWithdraw` derives from it.
    function maxRedeem(address owner) public view override returns (uint256) {
        return _inWindow(owner) ? super.maxRedeem(owner) : 0;
    }

    /// @inheritdoc IKeelsonReserve
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// @dev Shares cannot be moved into an owner whose cooldown runs, which would let them leave without waiting.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && _cooling(to)) revert CooldownActive();
        super._update(from, to, value);
    }

    function _setCooldown(uint40 cooldown_, uint40 unstakeWindow_) internal {
        cooldown = cooldown_;
        unstakeWindow = unstakeWindow_;
        // forge-lint: disable-next-line(reentrancy-events)
        emit CooldownSet(cooldown_, unstakeWindow_);
    }

    function _inWindow(address owner) internal view returns (bool) {
        uint256 start = cooldownStart[owner];
        return start != 0 && block.timestamp >= start + cooldown && block.timestamp <= start + cooldown + unstakeWindow;
    }

    function _cooling(address owner) internal view returns (bool) {
        uint256 start = cooldownStart[owner];
        return start != 0 && block.timestamp <= start + cooldown + unstakeWindow;
    }
}
