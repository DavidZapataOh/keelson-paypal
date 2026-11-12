// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {GuardianSafe} from "./GuardianSafe.sol";
import {ISafe} from "./interfaces/ISafe.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys the Base governance of the TDX leg's dstack app from `deployments/8453.json`: the 2-of-3
/// guardian Safe (the same CREATE2 address as on every chain with these owners), and a `TimelockController` with the
/// governance proposer, the 48 h delay, any executor, and the guardian as canceller. No admin remains.
contract DeployBaseKmsGovernance is Script {
    using stdJson for string;

    function run() external returns (ISafe guardian, TimelockController timelock) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/8453.json"));
        vm.startBroadcast();
        guardian = GuardianSafe.ensure(json);
        timelock = deploy(json, address(guardian), msg.sender);
        vm.stopBroadcast();
    }

    /// @notice The timelock, with `admin` granting the guardian's cancel role and then renouncing.
    function deploy(string memory json, address guardian, address admin) public returns (TimelockController timelock) {
        address[] memory proposers = new address[](1);
        proposers[0] = json.readAddress(".governance.proposer");
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new TimelockController(json.readUint(".governance.timelockMinDelay"), proposers, executors, admin);
        timelock.grantRole(timelock.CANCELLER_ROLE(), guardian);
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), admin);
    }
}
