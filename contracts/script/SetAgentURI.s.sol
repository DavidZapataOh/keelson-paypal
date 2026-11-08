// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC8004Identity} from "../src/interfaces/IERC8004Identity.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Points the demo operator's ERC-8004 agent at the registration file the Keelson API serves for its owner.
/// The operator (`KEELSON_OPERATOR_KEY`) sends the transaction.
/// @dev `forge script script/SetAgentURI.s.sol --rpc-url arbitrum_sepolia --broadcast`
contract SetAgentURI is KeelsonDeploy {
    using stdJson for string;

    function run() external returns (string memory uri) {
        string memory json = _registry();
        IERC8004Identity identity = IERC8004Identity(json.readAddress(".external.erc8004Identity"));
        uint256 agentId = json.readUint(".demo.agentId");
        address operator = json.readAddress(".demo.operator");
        uri = string.concat(
            "https://api.keelson.finance/v1/operators/by-address/", vm.toString(operator), "/registration.json"
        );
        vm.broadcast(vm.envUint("KEELSON_OPERATOR_KEY"));
        identity.setAgentURI(agentId, uri);
        require(keccak256(bytes(identity.tokenURI(agentId))) == keccak256(bytes(uri)), "agent URI not set");
    }
}
