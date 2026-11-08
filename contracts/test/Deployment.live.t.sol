// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Deploy} from "../script/Deploy.s.sol";
import {ISafe} from "../script/interfaces/ISafe.sol";
import {KeelsonRoles} from "../src/access/KeelsonRoles.sol";
import {KeelsonDeployer} from "../src/deploy/KeelsonDeployer.sol";
import {ForkTest} from "./utils/Fork.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The live chains match their registries; chains with no deployment yet are skipped.
contract DeploymentLiveTest is ForkTest {
    using stdJson for string;

    string[4] internal GOVERNANCE = ["KeelsonDeployer", "AccessManager", "TimelockController", "GuardianSafe"];

    function test_LiveDeploymentsMatchRegistries() public {
        address[4] memory first;
        uint256 deployedChains;
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            string memory json = _jsonOf(CHAIN_IDS[i]);
            string[] memory names = vm.parseJsonKeys(json, ".contracts");
            if (names.length == 0) continue;
            ++deployedChains;
            vm.createSelectFork(vm.envString(json.readString(".rpcEnv")));
            string memory chain = vm.toString(CHAIN_IDS[i]);

            for (uint256 j; j < names.length; ++j) {
                address deployed = json.readAddress(string.concat(".contracts.", names[j]));
                assertGt(deployed.code.length, 0, string.concat(chain, " ", names[j]));
            }
            for (uint256 j; j < GOVERNANCE.length; ++j) {
                address deployed = json.readAddress(string.concat(".contracts.", GOVERNANCE[j]));
                if (first[j] == address(0)) first[j] = deployed;
                assertEq(deployed, first[j], string.concat(chain, " ", GOVERNANCE[j]));
            }
            _checkGovernance(json, chain);
        }
        assertGe(deployedChains, 2);
    }

    function _checkGovernance(string memory json, string memory chain) internal {
        address owner = json.readAddress(".governance.proposer");
        AccessManager manager = AccessManager(json.readAddress(".contracts.AccessManager"));
        TimelockController timelock = TimelockController(payable(json.readAddress(".contracts.TimelockController")));
        ISafe guardian = ISafe(json.readAddress(".contracts.GuardianSafe"));

        Deploy script = new Deploy();
        assertEq(KeelsonDeployer(json.readAddress(".contracts.KeelsonDeployer")).owner(), owner, chain);
        assertEq(json.readAddress(".contracts.KeelsonDeployer"), script.deployerAddress(), chain);
        assertEq(address(manager), script.predict("AccessManager"), chain);
        assertEq(address(timelock), script.predict("TimelockController"), chain);
        assertEq(address(guardian), script.predictGuardian(json), chain);
        assertEq(timelock.getMinDelay(), json.readUint(".params.timelockMinDelay"), chain);
        assertEq(guardian.getThreshold(), json.readUint(".governance.guardianThreshold"), chain);
        assertEq(guardian.getOwners().length, json.readAddressArray(".governance.guardianOwners").length, chain);

        (bool isAdmin,) = manager.hasRole(KeelsonRoles.ADMIN_ROLE, address(timelock));
        assertTrue(isAdmin, chain);
        for (uint64 role = KeelsonRoles.ADMIN_ROLE; role <= KeelsonRoles.SIGNERS_ROLE; ++role) {
            (bool member,) = manager.hasRole(role, owner);
            assertFalse(member, chain);
        }
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), owner), chain);
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), address(guardian)), chain);
        (, uint32 signersDelay) = manager.hasRole(KeelsonRoles.SIGNERS_ROLE, address(timelock));
        assertEq(signersDelay, json.readUint(".params.signersDelay"), chain);
    }
}
