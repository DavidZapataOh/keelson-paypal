// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployRegisteredUserSet} from "../script/DeployRegisteredUserSet.s.sol";
import {RegisteredUserSet} from "../src/RegisteredUserSet.sol";
import {ForkTest} from "./utils/Fork.sol";
import {IAccessManaged} from "@openzeppelin/contracts/access/manager/IAccessManaged.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The deploy script on today's Arbitrum Sepolia: once the timelock wires it, the relayer, and no one else,
/// publishes roots, and a demo C3 proof verifies under a published root through the deployed verifier.
contract RegisteredUserSetForkTest is ForkTest {
    using stdJson for string;

    function test_ScriptDeploysAndWiresTheRelayer() public {
        string memory json = _jsonOf(421614);
        vm.createSelectFork(vm.envString(json.readString(".rpcEnv")));
        DeployRegisteredUserSet script = new DeployRegisteredUserSet();
        RegisteredUserSet users = script.run();
        assertEq(address(users), script.predict("RegisteredUserSet"));
        assertEq(users.authority(), json.readAddress(".contracts.AccessManager"));
        assertEq(address(users.verifier()), json.readAddress(".contracts.AnonymousMandateVerifier"));
        if (!script.wired()) {
            TimelockController timelock = TimelockController(payable(json.readAddress(".contracts.TimelockController")));
            vm.warp(block.timestamp + timelock.getMinDelay());
            script.wire();
        }
        assertTrue(script.wired());
        // Both entrypoints are idempotent.
        script.run();
        script.wire();

        string memory v = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/c3-payment.json"));
        bytes memory proof = v.readBytes(".proof");
        bytes32[] memory inputs = v.readBytes32Array(".publicInputs");
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAccessManaged.AccessManagedUnauthorized.selector, stranger));
        users.publish(inputs[2], 3);
        assertFalse(users.verify(proof, inputs[0], inputs[1], inputs[2]));
        vm.prank(script.relayer());
        users.publish(inputs[2], 3);
        assertTrue(users.verify(proof, inputs[0], inputs[1], inputs[2]));
    }
}
