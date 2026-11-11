// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Script} from "forge-std/Script.sol";

/// @notice Deploys the Base `TimelockController` that owns the TDX leg's dstack app: the same proposer and the same
/// 48 h delay as the Arbitrum governance, anyone executes, and the Base guardian Safe can cancel. No admin remains.
/// @dev `BASE_PROPOSER` is the governance proposer and `BASE_GUARDIAN` the guardian Safe on Base.
contract DeployBaseKmsGovernance is Script {
    uint256 internal constant MIN_DELAY = 172_800;

    function run() external returns (TimelockController timelock) {
        address proposer = vm.envAddress("BASE_PROPOSER");
        address guardian = vm.envAddress("BASE_GUARDIAN");
        vm.startBroadcast();
        timelock = deploy(proposer, guardian, msg.sender);
        vm.stopBroadcast();
    }

    /// @notice The timelock, with `admin` granting the guardian's cancel role and then renouncing.
    function deploy(address proposer, address guardian, address admin) public returns (TimelockController timelock) {
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new TimelockController(MIN_DELAY, proposers, executors, admin);
        timelock.grantRole(timelock.CANCELLER_ROLE(), guardian);
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), admin);
    }
}
