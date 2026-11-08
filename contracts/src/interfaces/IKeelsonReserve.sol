// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonTypes} from "../libraries/KeelsonTypes.sol";

/// @title IKeelsonReserve
/// @notice Keelson's warranty pool: an ERC-4626 vault over PYUSD that collects every premium and pays the merchant when
/// a verdict signed by both TEE legs names Keelson liable.
interface IKeelsonReserve {
    event WarrantyPaid(
        bytes32 indexed disputeId, bytes32 indexed coverageId, address payee, uint96 amount, bytes32 verdictDigest
    );
    /// @notice The transfer to `recipient` failed (a frozen address, a paused token): the amount waits in `claimable`.
    event PayoutFailed(bytes32 indexed disputeId, address indexed recipient, uint96 amount);
    event Claimed(address indexed account, address to, uint256 amount);
    event CooldownRequested(address indexed owner, uint40 start);
    event CooldownSet(uint40 cooldown, uint40 unstakeWindow);
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
    /// @notice Shares cannot move to, or be minted for, an owner whose cooldown runs or whose window is open.
    error CooldownActive();
    /// @notice The coverage's dispute window closed before the warranty arrived.
    error WarrantyWindowClosed();

    /// @notice Pays `v.payee` from the reserve on a verdict that names Keelson liable, signed by both TEE legs against a
    /// checkpoint anchored at `treeSize`.
    function payWarranty(KeelsonTypes.Verdict calldata v, uint64 treeSize, bytes calldata sigs) external;

    /// @notice Pays all of `account`'s failed payouts to `to`. Gasless: anyone may submit `account`'s `Claim`
    /// signature; `sig` is ignored when `account` is the caller.
    function claim(address account, address to, uint256 nonce, uint256 deadline, bytes calldata sig) external;

    /// @notice Starts the caller's cooldown: it may withdraw from `cooldown` after now until `unstakeWindow` later.
    function requestCooldown() external;

    function setCooldown(uint40 cooldown, uint40 unstakeWindow) external;

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
