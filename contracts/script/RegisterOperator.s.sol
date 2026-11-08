// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC8004Identity} from "../src/interfaces/IERC8004Identity.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";

/// @notice Registers the demo operator in the official ERC-8004 Identity registry: the deployer registers an agent,
/// which pays the gas, and transfers it to the operator's address (`KEELSON_OPERATOR_KEY`).
/// @dev `forge script script/RegisterOperator.s.sol --rpc-url arbitrum_sepolia --account keelson-deployer --broadcast`
contract RegisterOperator is KeelsonDeploy {
    using stdJson for string;

    function run() external returns (uint256 agentId) {
        IERC8004Identity identity = IERC8004Identity(_registry().readAddress(".external.erc8004Identity"));
        address operator = vm.addr(vm.envUint("KEELSON_OPERATOR_KEY"));
        vm.startBroadcast(_owner());
        agentId = identity.register();
        identity.transferFrom(_owner(), operator, agentId);
        vm.stopBroadcast();
        require(identity.ownerOf(agentId) == operator, "operator does not own the agent");
        console.log("DEMO_AGENT_ID", agentId);
    }
}
