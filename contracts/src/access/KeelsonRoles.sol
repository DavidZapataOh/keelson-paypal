// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @title KeelsonRoles
/// @notice Role ids of the AccessManager that governs every Keelson contract.
library KeelsonRoles {
    /// @notice OpenZeppelin `AccessManager.ADMIN_ROLE`; held only by the TimelockController.
    uint64 internal constant ADMIN_ROLE = 0;
    /// @notice Guardian Safe, no delay: veto and pause new coverage only.
    uint64 internal constant GUARDIAN_ROLE = 1;
    /// @notice Timelock: parameter changes.
    uint64 internal constant PARAMETERS_ROLE = 2;
    /// @notice Timelock plus an execution delay of at least the withdrawal delay: signer and measurement rotation.
    uint64 internal constant SIGNERS_ROLE = 3;
    /// @notice OpenZeppelin `AccessManager.PUBLIC_ROLE`.
    uint64 internal constant PUBLIC_ROLE = type(uint64).max;
}
