// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonBondVault} from "../src/KeelsonBondVault.sol";
import {KeelsonReserve} from "../src/KeelsonReserve.sol";
import {RegisteredUserSet} from "../src/RegisteredUserSet.sol";
import {VerdictVerifier} from "../src/VerdictVerifier.sol";
import {KeelsonRoles} from "../src/access/KeelsonRoles.sol";
import {ForkTest} from "./utils/Fork.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The role map each live chain's AccessManager holds for the deployed contracts; chains without them are
/// skipped.
contract RolesLiveTest is ForkTest {
    using stdJson for string;

    /// @dev Slots of `AccessManager._targets` and `_roles` (OpenZeppelin Contracts v5.7.0).
    uint256 internal constant TARGETS_SLOT = 0;
    uint256 internal constant ROLES_SLOT = 1;

    function test_LiveRoleMap() public {
        uint256 checked;
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            string memory json = _jsonOf(CHAIN_IDS[i]);
            if (!vm.keyExistsJson(json, ".contracts.VerdictVerifier")) continue;
            ++checked;
            vm.createSelectFork(vm.envString(json.readString(".rpcEnv")));
            _checkRoles(json, vm.toString(CHAIN_IDS[i]));
        }
        assertGe(checked, 1);
    }

    function _checkRoles(string memory json, string memory chain) internal view {
        AccessManager manager = AccessManager(json.readAddress(".contracts.AccessManager"));
        address timelock = json.readAddress(".contracts.TimelockController");
        address guardian = json.readAddress(".contracts.GuardianSafe");
        address owner = json.readAddress(".governance.proposer");
        address verifier = json.readAddress(".contracts.VerdictVerifier");
        address vault = json.readAddress(".contracts.KeelsonBondVault");
        address reserve = json.readAddress(".contracts.KeelsonReserve");
        uint32 signersDelay = uint32(json.readUint(".params.signersDelay"));

        _assertRole(manager, verifier, VerdictVerifier.setAllowedMeasurement.selector, KeelsonRoles.SIGNERS_ROLE, chain);
        _assertRole(manager, verifier, VerdictVerifier.setIssuer.selector, KeelsonRoles.SIGNERS_ROLE, chain);
        _assertRole(manager, verifier, VerdictVerifier.revokeSigner.selector, KeelsonRoles.GUARDIAN_ROLE, chain);
        _assertRole(manager, verifier, VerdictVerifier.disallowMeasurement.selector, KeelsonRoles.GUARDIAN_ROLE, chain);
        _assertRole(manager, vault, KeelsonBondVault.setParams.selector, KeelsonRoles.PARAMETERS_ROLE, chain);
        _assertRole(manager, vault, KeelsonBondVault.setRateLimit.selector, KeelsonRoles.PARAMETERS_ROLE, chain);
        _assertRole(manager, vault, KeelsonBondVault.pause.selector, KeelsonRoles.GUARDIAN_ROLE, chain);
        _assertRole(manager, vault, KeelsonBondVault.unpause.selector, KeelsonRoles.GUARDIAN_ROLE, chain);
        _assertRole(manager, vault, KeelsonBondVault.vetoSlash.selector, KeelsonRoles.GUARDIAN_ROLE, chain);
        _assertRole(manager, reserve, KeelsonReserve.setCooldown.selector, KeelsonRoles.PARAMETERS_ROLE, chain);
        _assertRole(manager, reserve, KeelsonReserve.setRateLimit.selector, KeelsonRoles.PARAMETERS_ROLE, chain);

        _assertMember(manager, KeelsonRoles.ADMIN_ROLE, timelock, 0, chain);
        _assertMember(manager, KeelsonRoles.PARAMETERS_ROLE, timelock, 0, chain);
        _assertMember(manager, KeelsonRoles.SIGNERS_ROLE, timelock, signersDelay, chain);
        _assertMember(manager, KeelsonRoles.GUARDIAN_ROLE, guardian, 0, chain);
        address[3] memory outsiders = [owner, guardian, json.readAddress(".contracts.KeelsonDeployer")];
        for (uint256 j; j < outsiders.length; ++j) {
            (bool admin,) = manager.hasRole(KeelsonRoles.ADMIN_ROLE, outsiders[j]);
            (bool signer,) = manager.hasRole(KeelsonRoles.SIGNERS_ROLE, outsiders[j]);
            assertFalse(admin || signer, chain);
        }

        // A signer rotation waits at least as long as a withdrawal, so a bond cannot leave ahead of a new signer set.
        assertGe(signersDelay, KeelsonBondVault(vault).params().withdrawalDelay, chain);
        bytes32 role = keccak256(abi.encode(KeelsonRoles.SIGNERS_ROLE, ROLES_SLOT));
        _assertDelay(manager, manager.getRoleGrantDelay(KeelsonRoles.SIGNERS_ROLE), role, 128, signersDelay, chain);
        bytes32 target = keccak256(abi.encode(verifier, TARGETS_SLOT));
        _assertDelay(manager, manager.getTargetAdminDelay(verifier), target, 0, signersDelay, chain);
        assertEq(VerdictVerifier(verifier).authority(), address(manager), chain);
        assertEq(KeelsonBondVault(vault).authority(), address(manager), chain);
        assertEq(KeelsonReserve(reserve).authority(), address(manager), chain);

        if (vm.keyExistsJson(json, ".contracts.RegisteredUserSet")) {
            address users = json.readAddress(".contracts.RegisteredUserSet");
            address relayer = json.readAddress(".relayer");
            _assertRole(manager, users, RegisteredUserSet.publish.selector, KeelsonRoles.PUBLISHER_ROLE, chain);
            _assertRole(manager, users, RegisteredUserSet.revoke.selector, KeelsonRoles.GUARDIAN_ROLE, chain);
            _assertMember(manager, KeelsonRoles.PUBLISHER_ROLE, relayer, 0, chain);
            for (uint256 j; j < outsiders.length; ++j) {
                (bool publisher,) = manager.hasRole(KeelsonRoles.PUBLISHER_ROLE, outsiders[j]);
                assertFalse(publisher, chain);
            }
            assertEq(RegisteredUserSet(users).authority(), address(manager), chain);
        }
    }

    function _assertRole(AccessManager manager, address target, bytes4 selector, uint64 role, string memory chain)
        internal
        view
    {
        assertEq(manager.getTargetFunctionRole(target, selector), role, chain);
    }

    /// @dev A grant or admin delay is raised only after `minSetback`; until then the scheduled value must be the
    /// expected one. `Time.Delay` packs `effect ‖ valueBefore ‖ valueAfter` (48, 32, 32 bits) in the struct's second
    /// slot, at bit `shift`.
    function _assertDelay(
        AccessManager manager,
        uint32 current,
        bytes32 base,
        uint256 shift,
        uint32 expected,
        string memory chain
    ) internal view {
        if (current == expected) return;
        uint256 packed = uint256(vm.load(address(manager), bytes32(uint256(base) + 1))) >> shift;
        assertEq(uint32(packed), expected, chain);
        assertGt(uint48(packed >> 64), vm.getBlockTimestamp(), chain);
    }

    function _assertMember(AccessManager manager, uint64 role, address account, uint32 delay, string memory chain)
        internal
        view
    {
        (bool member, uint32 executionDelay) = manager.hasRole(role, account);
        assertTrue(member, chain);
        assertEq(executionDelay, delay, chain);
    }
}
