// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Deploy} from "../script/Deploy.s.sol";
import {KeelsonRoles} from "../src/access/KeelsonRoles.sol";
import {ForkTest} from "./utils/Fork.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The release deployed by the real deployer EOA on every chain's pinned fork.
contract DeployForkTest is ForkTest {
    using stdJson for string;

    function setUp() public {
        _forkAll();
    }

    function _deployOn(uint256 chainId) internal returns (Deploy.Release memory release) {
        _select(chainId);
        string memory json = _json();
        string memory name = vm.toString(chainId);
        address owner = json.readAddress(".governance.proposer");

        release = _deployRelease();

        assertEq(release.deployer.owner(), owner, name);
        address[] memory owners = release.guardian.getOwners();
        address[] memory expected = json.readAddressArray(".governance.guardianOwners");
        assertEq(owners.length, expected.length, name);
        for (uint256 i; i < expected.length; ++i) {
            bool found;
            for (uint256 j; j < owners.length; ++j) {
                found = found || owners[j] == expected[i];
            }
            assertTrue(found, name);
        }
        assertEq(release.guardian.getThreshold(), json.readUint(".governance.guardianThreshold"), name);
        assertEq(release.timelock.getMinDelay(), json.readUint(".params.timelockMinDelay"), name);

        (bool isAdmin,) = release.manager.hasRole(KeelsonRoles.ADMIN_ROLE, owner);
        assertFalse(isAdmin, name);
        (isAdmin,) = release.manager.hasRole(KeelsonRoles.ADMIN_ROLE, address(release.timelock));
        assertTrue(isAdmin, name);
        for (uint64 role = KeelsonRoles.GUARDIAN_ROLE; role <= KeelsonRoles.SIGNERS_ROLE; ++role) {
            (bool member,) = release.manager.hasRole(role, owner);
            assertFalse(member, name);
        }
        assertFalse(release.timelock.hasRole(release.timelock.DEFAULT_ADMIN_ROLE(), owner), name);
        assertTrue(release.timelock.hasRole(release.timelock.CANCELLER_ROLE(), address(release.guardian)), name);
        (bool guardianMember, uint32 guardianDelay) =
            release.manager.hasRole(KeelsonRoles.GUARDIAN_ROLE, address(release.guardian));
        assertTrue(guardianMember, name);
        assertEq(guardianDelay, 0, name);
        (, uint32 signersDelay) = release.manager.hasRole(KeelsonRoles.SIGNERS_ROLE, address(release.timelock));
        assertEq(signersDelay, json.readUint(".params.signersDelay"), name);
    }

    function test_SameGovernanceOnEveryChain() public {
        Deploy.Release memory first = _deployOn(CHAIN_IDS[0]);
        for (uint256 i = 1; i < CHAIN_IDS.length; ++i) {
            Deploy.Release memory release = _deployOn(CHAIN_IDS[i]);
            assertEq(address(release.deployer), address(first.deployer));
            assertEq(address(release.manager), address(first.manager));
            assertEq(address(release.timelock), address(first.timelock));
            assertEq(address(release.guardian), address(first.guardian));
        }
    }
}
