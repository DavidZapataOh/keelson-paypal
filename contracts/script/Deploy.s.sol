// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonRoles} from "../src/access/KeelsonRoles.sol";
import {KeelsonDeployer} from "../src/deploy/KeelsonDeployer.sol";
import {GuardianSafe} from "./GuardianSafe.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {ISafe} from "./interfaces/ISafe.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys a full Keelson release on the chain it runs against, then hands governance to the timelock.
/// @dev Every step checks current state first, so a re-run does only what is missing.
contract Deploy is KeelsonDeploy {
    using stdJson for string;

    struct Release {
        KeelsonDeployer deployer;
        AccessManager manager;
        TimelockController timelock;
        ISafe guardian;
    }

    function run() external returns (Release memory release) {
        vm.startBroadcast(_owner());
        release.deployer = _ensureDeployer();
        _deployGovernance(release);
        _wireRoles(release);
        _handOver(release);
        vm.stopBroadcast();
    }

    function _deployGovernance(Release memory release) internal {
        string memory json = _registry();
        address owner = _owner();

        release.manager = AccessManager(_deploy("AccessManager", type(AccessManager).creationCode, abi.encode(owner)));

        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        release.timelock = TimelockController(
            payable(_deploy(
                    "TimelockController",
                    type(TimelockController).creationCode,
                    abi.encode(json.readUint(".params.timelockMinDelay"), proposers, executors, owner)
                ))
        );

        release.guardian = _deployGuardian(json);
    }

    function _deployGuardian(string memory json) internal returns (ISafe guardian) {
        guardian = GuardianSafe.ensure(json);
        _record("GuardianSafe", address(guardian), abi.encode(json.readAddress(".external.safeL2")));
    }

    /// @notice The Guardian Safe's address: CREATE2 by the Safe factory over the owners, threshold and salt nonce.
    function predictGuardian(string memory json) public pure returns (address) {
        return GuardianSafe.predict(json);
    }

    /// @dev Later releases map each `restricted` function here with `setTargetFunctionRole`. A target with
    /// SIGNERS_ROLE functions also needs `setTargetAdminDelay(target, signersDelay)`, or the admin could re-map them.
    function _wireRoles(Release memory release) internal {
        AccessManager manager = release.manager;
        (bool isAdmin,) = manager.hasRole(KeelsonRoles.ADMIN_ROLE, _owner());
        if (!isAdmin) return;

        manager.labelRole(KeelsonRoles.GUARDIAN_ROLE, "GUARDIAN");
        manager.labelRole(KeelsonRoles.PARAMETERS_ROLE, "PARAMETERS");
        manager.labelRole(KeelsonRoles.SIGNERS_ROLE, "SIGNERS");

        uint32 signersDelay = uint32(_registry().readUint(".params.signersDelay"));
        _grant(manager, KeelsonRoles.GUARDIAN_ROLE, address(release.guardian), 0);
        _grant(manager, KeelsonRoles.PARAMETERS_ROLE, address(release.timelock), 0);
        _grant(manager, KeelsonRoles.SIGNERS_ROLE, address(release.timelock), signersDelay);
        // Without a grant delay the admin could revoke and re-grant SIGNERS_ROLE with no execution delay in one
        // timelock batch. In force after `minSetback`.
        if (manager.getRoleGrantDelay(KeelsonRoles.SIGNERS_ROLE) != signersDelay) {
            manager.setGrantDelay(KeelsonRoles.SIGNERS_ROLE, signersDelay);
        }
    }

    function _grant(AccessManager manager, uint64 role, address account, uint32 executionDelay) internal {
        (bool isMember, uint32 currentDelay) = manager.hasRole(role, account);
        if (!isMember || currentDelay != executionDelay) manager.grantRole(role, account, executionDelay);
    }

    /// @dev After this the deployer holds no role in the manager or the timelock; it keeps only the proposer role
    /// (whose operations wait for the timelock delay and the Guardian can cancel) and `KeelsonDeployer`.
    function _handOver(Release memory release) internal {
        address owner = _owner();
        TimelockController timelock = release.timelock;
        AccessManager manager = release.manager;

        if (timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), owner)) {
            if (!timelock.hasRole(timelock.CANCELLER_ROLE(), address(release.guardian))) {
                timelock.grantRole(timelock.CANCELLER_ROLE(), address(release.guardian));
            }
            timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), owner);
        }

        (bool ownerIsAdmin,) = manager.hasRole(KeelsonRoles.ADMIN_ROLE, owner);
        if (ownerIsAdmin) {
            _grant(manager, KeelsonRoles.ADMIN_ROLE, address(timelock), 0);
            manager.renounceRole(KeelsonRoles.ADMIN_ROLE, owner);
        }
    }
}
