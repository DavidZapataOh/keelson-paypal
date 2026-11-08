// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Create3} from "@openzeppelin/contracts/utils/Create3.sol";

/// @title KeelsonDeployer
/// @notice Deploys Keelson contracts with CREATE3, so each contract's address depends only on its salt.
/// @dev Deployed through the deterministic CREATE2 factory with salt zero and the owner as constructor argument,
/// which gives it the same address on every chain. Only the owner can deploy, so nobody can claim a Keelson
/// address on a chain the owner has not reached yet.
contract KeelsonDeployer {
    /// @notice The only account allowed to deploy.
    address public immutable owner;

    /// @notice Emitted when `deployed` is created from `salt`.
    event Deployed(bytes32 indexed salt, address indexed deployed);

    /// @notice The caller is not the owner.
    error Unauthorized();

    // forge-lint: disable-next-line(missing-zero-check)
    constructor(address owner_) {
        owner = owner_;
    }

    /// @notice Deploys `initCode` at the address {predict} returns for `salt`.
    /// @dev Reverts if `salt` was already used.
    function deploy(bytes32 salt, bytes calldata initCode) external returns (address deployed) {
        if (msg.sender != owner) revert Unauthorized();
        deployed = Create3.deploy(0, salt, initCode);
        // forge-lint: disable-next-line(reentrancy-events)
        emit Deployed(salt, deployed);
    }

    /// @notice The address a deployment with `salt` lands at, whatever its init code.
    function predict(bytes32 salt) external view returns (address) {
        return Create3.computeAddress(salt);
    }
}
