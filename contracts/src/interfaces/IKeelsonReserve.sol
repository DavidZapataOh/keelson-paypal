// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonTypes} from "../libraries/KeelsonTypes.sol";

/// @title IKeelsonReserve
/// @notice Keelson's warranty pool: an ERC-7540 vault over PYUSD, with synchronous deposits and asynchronous redemptions,
/// that collects every premium and pays the merchant when a verdict signed by both TEE legs names Keelson liable.
interface IKeelsonReserve {
    event WarrantyPaid(
        bytes32 indexed disputeId, bytes32 indexed coverageId, address payee, uint96 amount, bytes32 verdictDigest
    );
    /// @notice The transfer to `recipient` failed (a frozen address, a paused token): the amount waits in `claimable`.
    event PayoutFailed(bytes32 indexed disputeId, address indexed recipient, uint96 amount);
    event Claimed(address indexed account, address to, uint256 amount);
    /// @notice ERC-7540: `operator` may, or may no longer, request and claim redemptions for `controller`.
    event OperatorSet(address indexed controller, address indexed operator, bool approved);
    /// @notice ERC-7540: `owner`'s `shares` moved into the reserve for `controller` to redeem once fulfilled.
    event RedeemRequest(
        address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares
    );
    /// @notice `controller`'s pending shares were burned at the current share price for `assets` it can now claim.
    event RedeemFulfilled(address indexed controller, uint256 shares, uint256 assets);
    event CooldownSet(uint40 cooldown);
    event RateLimitSet(uint48 window, uint208 capacity);

    error InvalidVerdictSignature();
    error NotKeelsonLiable();
    /// @notice The dispute was already settled, by a slash or a warranty. On a retry it means done.
    error AlreadySettled();
    error Expired();
    error NotAnchored();
    error UnknownCoverage();
    error ExceedsCoverage();
    error InsufficientReserve();
    error InvalidSignature();
    error ZeroAmount();
    /// @notice The caller is neither the controller nor one of its operators.
    error NotOperator();
    /// @notice The controller has no pending request, or its cooldown has not passed.
    error RedeemNotReady();
    /// @notice ERC-7540: a redemption's assets are fixed when it is fulfilled, so there is nothing to preview.
    error AsyncRedeem();
    /// @notice The coverage's dispute window closed before the warranty arrived.
    error WarrantyWindowClosed();

    /// @notice Pays `v.payee` from the reserve on a verdict that names Keelson liable, signed by both TEE legs against a
    /// checkpoint anchored at `treeSize`.
    function payWarranty(KeelsonTypes.Verdict calldata v, uint64 treeSize, bytes calldata sigs) external;

    /// @notice Pays all of `account`'s failed payouts to `to`. Gasless: anyone may submit `account`'s `Claim`
    /// signature; `sig` is ignored when `account` is the caller.
    function claim(address account, address to, uint256 nonce, uint256 deadline, bytes calldata sig) external;

    /// @notice ERC-7540: moves `owner`'s `shares` into the reserve as `controller`'s pending redemption. The caller is
    /// `owner`, one of its operators, or spends its allowance. The shares keep bearing warranties until fulfilled; a new
    /// request restarts the controller's cooldown. Returns request id 0: one aggregated request per controller.
    function requestRedeem(uint256 shares, address controller, address owner) external returns (uint256 requestId);

    /// @notice Burns `controller`'s pending shares at the current share price once `cooldown` has passed since its last
    /// request, and sets the assets aside for it to claim with `redeem` or `withdraw`. Anyone may call it.
    function fulfillRedeem(address controller) external returns (uint256 assets);

    /// @notice ERC-7540: shares of `controller` waiting for fulfilment.
    function pendingRedeemRequest(uint256 requestId, address controller) external view returns (uint256 shares);

    /// @notice ERC-7540: fulfilled shares of `controller` it can claim.
    function claimableRedeemRequest(uint256 requestId, address controller) external view returns (uint256 shares);

    /// @notice When `controller` may fulfil its pending request.
    function redeemReadyAt(address controller) external view returns (uint256);

    function setOperator(address operator, bool approved) external returns (bool);

    function isOperator(address controller, address operator) external view returns (bool);

    /// @notice ERC-7575: the share token, this contract.
    function share() external view returns (address);

    /// @notice Assets set aside for fulfilled redemptions; not part of `totalAssets`.
    function totalClaimableRedeem() external view returns (uint256);

    function setCooldown(uint40 cooldown) external;

    function setRateLimit(uint48 window, uint208 capacity) external;

    /// @notice PYUSD that warranties may still pay out now.
    function rateLimitAvailable() external view returns (uint256);

    function settled(bytes32 disputeId) external view returns (bool);

    function claimable(address account) external view returns (uint256);

    /// @notice Warranties paid for a coverage; a slash of the same coverage can take only what they left.
    function warranted(bytes32 coverageId) external view returns (uint256);

    /// @notice PYUSD owed to payees whose transfers failed; not part of `totalAssets`.
    function totalClaimable() external view returns (uint256);

    function domainSeparator() external view returns (bytes32);
}
