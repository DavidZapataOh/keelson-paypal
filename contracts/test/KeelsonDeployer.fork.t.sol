// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonDeployer} from "../src/deploy/KeelsonDeployer.sol";
import {Test} from "forge-std/Test.sol";

contract KeelsonDeployerForkTest is Test {
    address internal constant DEPLOYER = address(0xA11CE);

    function _deployOn(string memory rpc, uint256 blockNumber) internal returns (address deployer, address predicted) {
        vm.createSelectFork(rpc, blockNumber);
        bytes memory initCode = abi.encodePacked(type(KeelsonDeployer).creationCode, abi.encode(DEPLOYER));
        (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(bytes32(0), initCode));
        assertTrue(ok, rpc);
        deployer = address(bytes20(ret));
        assertEq(KeelsonDeployer(deployer).owner(), DEPLOYER);
        predicted = KeelsonDeployer(deployer).predict(keccak256(abi.encodePacked("keelson/v1", "/", "AccessManager")));
    }

    function test_SameDeployerAndPredictionsOnEveryChain() public {
        (address d1, address p1) = _deployOn("arbitrum_sepolia", 327137000);
        (address d2, address p2) = _deployOn("arbitrum", 522273000);
        (address d3, address p3) = _deployOn("sepolia", 12088200);
        assertEq(d1, d2);
        assertEq(d1, d3);
        assertEq(p1, p2);
        assertEq(p1, p3);
    }
}
