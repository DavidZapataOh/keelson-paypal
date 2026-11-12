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
import {RateLimiter} from "@openzeppelin/contracts/utils/RateLimiter.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title KeelsonReserve
/// @notice Keelson's warranty pool: an ERC-7540 vault over PYUSD whose shares (`kwPYUSD`) earn every coverage premium
/// and pay the merchant when both TEE legs name Keelson liable, within the coverage's dispute window and a rate limit.
/// Deposits are synchronous (ERC-4626). Redemptions are asynchronous (ERC-7540): a request moves the shares into the
/// reserve, where they keep bearing warranties for `cooldown`, so stakers cannot leave ahead of a warranty they see
/// coming; fulfilment then fixes the assets the controller claims. Not upgradeable.
/// @dev The virtual offset of 6 decimals is OpenZeppelin's mitigation of the first-depositor inflation attack. PYUSD
/// owed to payees whose transfers failed, and PYUSD set aside for fulfilled redemptions, are excluded from
/// `totalAssets`. Requests aggregate per controller under request id 0, as ERC-7540 allows.
contract KeelsonReserve is IKeelsonReserve, ERC4626, AccessManaged, EIP712, Nonces, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using RateLimiter for RateLimiter.RefillingBucket;

    uint8 internal constant LIABLE_KEELSON = 2;
    /// @dev ERC-165 ids: ERC-7540 operator methods, asynchronous redemption, ERC-7575 and ERC-165 itself.
    bytes4 internal constant ERC7540_OPERATOR = 0xe3bc4e65;
    bytes4 internal constant ERC7540_REDEEM = 0x620ee8e4;
    bytes4 internal constant ERC7575 = 0x2f0a18c5;
    bytes4 internal constant ERC165 = 0x01ffc9a7;
    uint256 internal constant TWO_SIGNATURES = 130;

    IVerdictVerifier public immutable verifier;
    ICheckpointAnchor public immutable anchor;
    IKeelsonBondVault public immutable vault;
    /// @notice `keccak256` of the origin of the log whose anchored checkpoints verdicts name.
    bytes32 public immutable logOrigin;

    /// @dev A controller's aggregated request: pending shares and when the last request came, then what fulfilment fixed.
    struct Redemption {
        uint128 pendingShares;
        uint40 requestedAt;
        uint128 claimableShares;
        uint128 claimableAssets;
    }

    /// @notice How long requested shares wait, still bearing warranties, before they can be fulfilled.
    uint40 public cooldown;
    mapping(address controller => Redemption) internal _redemptions;
    /// @inheritdoc IKeelsonReserve
    mapping(address controller => mapping(address operator => bool)) public isOperator;
    /// @inheritdoc IKeelsonReserve
    uint256 public totalClaimableRedeem;
    /// @inheritdoc IKeelsonReserve
    mapping(bytes32 disputeId => bool) public settled;
    /// @notice Warranties paid per coverage, never more than its amount.
    mapping(bytes32 coverageId => uint256) public warranted;
    /// @inheritdoc IKeelsonReserve
    mapping(address account => uint256) public claimable;
    /// @inheritdoc IKeelsonReserve
    uint256 public totalClaimable;
    /// @dev One global bucket (key 0) of PYUSD that warranties may pay out per window.
    RateLimiter.RefillingBucket internal _warrantyLimit;

    constructor(
        IERC20 pyusd,
        IVerdictVerifier verifier_,
        ICheckpointAnchor anchor_,
        IKeelsonBondVault vault_,
        bytes32 logOrigin_,
        address authority,
        uint40 cooldown_,
        uint48 rateLimitWindow,
        uint208 rateLimitCapacity
    ) ERC20("Keelson Warranty Reserve", "kwPYUSD") ERC4626(pyusd) AccessManaged(authority) EIP712("Keelson", "1") {
        verifier = verifier_;
        anchor = anchor_;
        vault = vault_;
        logOrigin = logOrigin_;
        _setCooldown(cooldown_);
        _warrantyLimit.updateSettings(rateLimitWindow, rateLimitCapacity);
        emit RateLimitSet(rateLimitWindow, rateLimitCapacity);
    }

    /// @inheritdoc IKeelsonReserve
    /// @dev Only 2-of-2: a warranty is Keelson paying from its own pool and can wait for both legs. It may come after the
    /// coverage was released, until one more dispute window has passed. Beyond the rate limit it reverts and can be
    /// retried once the bucket refills. One coverage pays at most its amount across slashes and warranties.
    function payWarranty(KeelsonTypes.Verdict calldata v, uint64 treeSize, bytes calldata sigs) external nonReentrant {
        bytes32 digest = verifier.hashTypedData(KeelsonTypes.hash(v));
        if (sigs.length != TWO_SIGNATURES || !verifier.verify2of2(digest, sigs)) revert InvalidVerdictSignature();
        if (v.liable != LIABLE_KEELSON) revert NotKeelsonLiable();
        if (v.amount == 0 || v.payee == address(0)) revert ZeroAmount();
        if (settled[v.disputeId] || vault.settled(v.disputeId)) revert AlreadySettled();
        if (block.timestamp > v.deadline) revert Expired();
        if (v.checkpointRoot == 0 || anchor.rootAt(logOrigin, treeSize) != v.checkpointRoot) revert NotAnchored();
        IKeelsonBondVault.CoverageState memory c = vault.coverages(v.coverageId);
        if (c.status == IKeelsonBondVault.Status.None || c.agentId != v.agentId) revert UnknownCoverage();
        if (block.timestamp > uint256(c.releaseAfter) + vault.params().disputeWindow) revert WarrantyWindowClosed();
        if (v.amount > c.amount - warranted[v.coverageId] - vault.slashed(v.coverageId)) revert ExceedsCoverage();
        if (v.amount > totalAssets()) revert InsufficientReserve();
        _warrantyLimit.consume(bytes32(0), v.amount);

        settled[v.disputeId] = true;
        warranted[v.coverageId] += v.amount;
        address recipient = vault.payoutAddress(v.payee);
        if (recipient == address(0)) recipient = v.payee;
        if (!IERC20(asset()).trySafeTransfer(recipient, v.amount)) {
            claimable[recipient] += v.amount;
            totalClaimable += v.amount;
            // forge-lint: disable-next-line(reentrancy-events)
            emit PayoutFailed(v.disputeId, recipient, v.amount);
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
    /// @dev Only the controller or its operator may add to its request, since every request restarts its cooldown.
    function requestRedeem(uint256 shares, address controller, address owner) external nonReentrant returns (uint256) {
        if (shares == 0) revert ZeroAmount();
        _onlyControllerOrOperator(controller);
        if (msg.sender != owner && !isOperator[owner][msg.sender]) _spendAllowance(owner, msg.sender, shares);
        _transfer(owner, address(this), shares);
        Redemption storage r = _redemptions[controller];
        r.pendingShares += SafeCast.toUint128(shares);
        r.requestedAt = SafeCast.toUint40(block.timestamp);
        // forge-lint: disable-next-line(reentrancy-events)
        emit RedeemRequest(controller, owner, 0, msg.sender, shares);
        return 0;
    }

    /// @inheritdoc IKeelsonReserve
    function fulfillRedeem(address controller) external nonReentrant returns (uint256 assets) {
        Redemption storage r = _redemptions[controller];
        uint256 shares = r.pendingShares;
        if (shares == 0 || block.timestamp < uint256(r.requestedAt) + cooldown) revert RedeemNotReady();
        // Priced before the burn and before the assets leave `totalAssets`, so the rate is today's.
        assets = _convertToAssets(shares, Math.Rounding.Floor);
        r.pendingShares = 0;
        r.claimableShares += SafeCast.toUint128(shares);
        r.claimableAssets += SafeCast.toUint128(assets);
        totalClaimableRedeem += assets;
        _burn(address(this), shares);
        // forge-lint: disable-next-line(reentrancy-events)
        emit RedeemFulfilled(controller, shares, assets);
    }

    /// @notice ERC-7540: claims `shares` of `controller`'s fulfilled redemption, paying their assets to `receiver`.
    function redeem(uint256 shares, address receiver, address controller)
        public
        override
        nonReentrant
        returns (uint256 assets)
    {
        _onlyControllerOrOperator(controller);
        Redemption storage r = _redemptions[controller];
        uint256 claimableShares = r.claimableShares;
        if (shares > claimableShares) revert ERC4626ExceededMaxRedeem(controller, shares, claimableShares);
        if (shares == 0) revert ZeroAmount();
        assets = shares == claimableShares ? r.claimableAssets : Math.mulDiv(r.claimableAssets, shares, claimableShares);
        _claimRedeem(r, controller, receiver, assets, shares);
    }

    /// @notice ERC-7540: claims `assets` of `controller`'s fulfilled redemption for `receiver`.
    function withdraw(uint256 assets, address receiver, address controller)
        public
        override
        nonReentrant
        returns (uint256 shares)
    {
        _onlyControllerOrOperator(controller);
        Redemption storage r = _redemptions[controller];
        uint256 claimableAssets = r.claimableAssets;
        if (assets > claimableAssets) revert ERC4626ExceededMaxWithdraw(controller, assets, claimableAssets);
        if (assets == 0) revert ZeroAmount();
        shares = assets == claimableAssets
            ? r.claimableShares
            : Math.mulDiv(r.claimableShares, assets, claimableAssets, Math.Rounding.Ceil);
        _claimRedeem(r, controller, receiver, assets, shares);
    }

    /// @inheritdoc IKeelsonReserve
    function setOperator(address operator, bool approved) external returns (bool) {
        isOperator[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
        return true;
    }

    /// @inheritdoc IKeelsonReserve
    function pendingRedeemRequest(uint256, address controller) external view returns (uint256) {
        return _redemptions[controller].pendingShares;
    }

    /// @inheritdoc IKeelsonReserve
    function claimableRedeemRequest(uint256, address controller) external view returns (uint256) {
        return _redemptions[controller].claimableShares;
    }

    /// @inheritdoc IKeelsonReserve
    function redeemReadyAt(address controller) external view returns (uint256) {
        return uint256(_redemptions[controller].requestedAt) + cooldown;
    }

    /// @inheritdoc IKeelsonReserve
    function share() external view returns (address) {
        return address(this);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == ERC7540_OPERATOR || interfaceId == ERC7540_REDEEM || interfaceId == ERC7575
            || interfaceId == ERC165;
    }

    /// @inheritdoc IKeelsonReserve
    function setCooldown(uint40 cooldown_) external restricted {
        _setCooldown(cooldown_);
    }

    /// @inheritdoc IKeelsonReserve
    /// @dev The bucket is synced first, so the new rate applies from now on.
    function setRateLimit(uint48 window, uint208 capacity) external restricted {
        _warrantyLimit.sync(bytes32(0));
        _warrantyLimit.updateSettings(window, capacity);
        // forge-lint: disable-next-line(reentrancy-events)
        emit RateLimitSet(window, capacity);
    }

    /// @inheritdoc IKeelsonReserve
    function rateLimitAvailable() external view returns (uint256) {
        return _warrantyLimit.available(bytes32(0));
    }

    /// @notice PYUSD held for the stakers: the balance less what failed payouts and fulfilled redemptions wait to claim.
    function totalAssets() public view override returns (uint256) {
        return Math.saturatingSub(IERC20(asset()).balanceOf(address(this)), totalClaimable + totalClaimableRedeem);
    }

    /// @notice ERC-7540: the shares `controller` can claim now.
    function maxRedeem(address controller) public view override returns (uint256) {
        return _redemptions[controller].claimableShares;
    }

    /// @notice ERC-7540: the assets `controller` can claim now.
    function maxWithdraw(address controller) public view override returns (uint256) {
        return _redemptions[controller].claimableAssets;
    }

    /// @notice Reverts, as ERC-7540 requires of an asynchronous redemption.
    function previewRedeem(uint256) public pure override returns (uint256) {
        revert AsyncRedeem();
    }

    /// @notice Reverts, as ERC-7540 requires of an asynchronous redemption.
    function previewWithdraw(uint256) public pure override returns (uint256) {
        revert AsyncRedeem();
    }

    /// @inheritdoc IKeelsonReserve
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    function _setCooldown(uint40 cooldown_) internal {
        cooldown = cooldown_;
        // forge-lint: disable-next-line(reentrancy-events)
        emit CooldownSet(cooldown_);
    }

    function _onlyControllerOrOperator(address controller) internal view {
        if (msg.sender != controller && !isOperator[controller][msg.sender]) revert NotOperator();
    }

    function _claimRedeem(Redemption storage r, address controller, address receiver, uint256 assets, uint256 shares)
        internal
    {
        // `assets` and `shares` are at most the claimable amounts, which are `uint128`.
        // forge-lint: disable-start(unsafe-typecast)
        r.claimableShares -= uint128(shares);
        r.claimableAssets -= uint128(assets);
        // forge-lint: disable-end(unsafe-typecast)
        totalClaimableRedeem -= assets;
        IERC20(asset()).safeTransfer(receiver, assets);
        // forge-lint: disable-next-line(reentrancy-events)
        emit Withdraw(msg.sender, receiver, controller, assets, shares);
    }
}
