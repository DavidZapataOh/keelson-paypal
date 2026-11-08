// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC8004Identity} from "../src/interfaces/IERC8004Identity.sol";
import {IERC8004Reputation} from "../src/interfaces/IERC8004Reputation.sol";
import {ForkTest} from "./utils/Fork.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The behaviour of the official ERC-8004 registries that Keelson's design rests on, on forks of the chains in
/// `deployments/`.
contract Erc8004RegistriesForkTest is ForkTest {
    using stdJson for string;

    IERC8004Identity internal identity;
    IERC8004Reputation internal reputation;

    function setUp() public {
        _forkAll();
        _select(421614);
        identity = _identity();
        reputation = IERC8004Reputation(_json().readAddress(".external.erc8004Reputation"));
    }

    function test_version_isPinnedOnEveryChain() public {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            _select(CHAIN_IDS[i]);
            assertEq(_identity().getVersion(), "2.0.0");
            assertEq(IERC8004Reputation(_json().readAddress(".external.erc8004Reputation")).getVersion(), "2.0.0");
        }
    }

    function test_register_ownerAndWallet_transferClearsWallet() public {
        address first = makeAddr("first owner");
        address second = makeAddr("second owner");
        vm.prank(first);
        uint256 agentId = identity.register();
        assertEq(identity.ownerOf(agentId), first);
        assertEq(identity.getAgentWallet(agentId), first);

        vm.prank(first);
        identity.transferFrom(first, second, agentId);
        assertEq(identity.ownerOf(agentId), second);
        assertEq(identity.getAgentWallet(agentId), address(0));
    }

    function test_giveFeedback_refusesOwnerAndApproved() public {
        address owner = makeAddr("erc8004 agent owner");
        address client = makeAddr("erc8004 client");
        vm.prank(owner);
        uint256 agentId = identity.register();

        vm.prank(owner);
        vm.expectRevert(bytes("Self-feedback not allowed"));
        reputation.giveFeedback(agentId, 100, 2, "keelson", "release", "", "", bytes32(0));

        vm.prank(owner);
        identity.setApprovalForAll(client, true);
        vm.prank(client);
        vm.expectRevert(bytes("Self-feedback not allowed"));
        reputation.giveFeedback(agentId, 100, 2, "keelson", "release", "", "", bytes32(0));
    }

    /// @dev Why Keelson rates with two decimals: the summary averages in the most frequent precision and truncates.
    function test_getSummary_averagesInTheModePrecision() public {
        address owner = makeAddr("erc8004 agent owner");
        address client = makeAddr("erc8004 client");
        vm.prank(owner);
        uint256 agentId = identity.register();
        address[] memory clients = new address[](1);
        clients[0] = client;

        vm.startPrank(client);
        reputation.giveFeedback(agentId, 100, 2, "keelson", "release", "", "", bytes32(0));
        reputation.giveFeedback(agentId, 100, 2, "keelson", "release", "", "", bytes32(0));
        reputation.giveFeedback(agentId, -100, 2, "keelson", "slash", "", "", bytes32(0));
        vm.stopPrank();
        (uint64 count, int128 value, uint8 decimals) = reputation.getSummary(agentId, clients, "keelson", "");
        assertEq(count, 3);
        assertEq(value, 33);
        assertEq(decimals, 2);

        vm.prank(owner);
        uint256 other = identity.register();
        vm.startPrank(client);
        reputation.giveFeedback(other, 1, 0, "keelson", "release", "", "", bytes32(0));
        reputation.giveFeedback(other, 1, 0, "keelson", "release", "", "", bytes32(0));
        reputation.giveFeedback(other, -1, 0, "keelson", "slash", "", "", bytes32(0));
        vm.stopPrank();
        (count, value, decimals) = reputation.getSummary(other, clients, "keelson", "");
        assertEq(count, 3);
        assertEq(value, 0);
        assertEq(decimals, 0);

        vm.expectRevert(bytes("clientAddresses required"));
        reputation.getSummary(agentId, new address[](0), "keelson", "");
    }
}
