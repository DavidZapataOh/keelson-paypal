// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonDeployer} from "../src/deploy/KeelsonDeployer.sol";
import {ForkTest} from "./utils/Fork.sol";
import {stdJson} from "forge-std/StdJson.sol";

contract KeelsonDeployerForkTest is ForkTest {
    using stdJson for string;

    function setUp() public {
        _forkAll();
    }

    /// @dev Exactly what `new KeelsonDeployer{salt: bytes32(0)}(owner)` does in a broadcast script.
    function _deployOn(uint256 chainId) internal returns (address deployer, address predicted) {
        _select(chainId);
        address owner = _json().readAddress(".governance.proposer");
        bytes memory initCode = abi.encodePacked(type(KeelsonDeployer).creationCode, abi.encode(owner));
        deployer = vm.computeCreate2Address(bytes32(0), keccak256(initCode));
        if (deployer.code.length == 0) {
            (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(bytes32(0), initCode));
            assertTrue(ok, vm.toString(chainId));
            assertEq(address(bytes20(ret)), deployer);
        }
        assertEq(KeelsonDeployer(deployer).owner(), owner);
        predicted = KeelsonDeployer(deployer).predict(keccak256(abi.encodePacked("keelson/v1", "/", "AccessManager")));
    }

    function test_SameDeployerAndPredictionsOnEveryChain() public {
        (address d1, address p1) = _deployOn(CHAIN_IDS[0]);
        for (uint256 i = 1; i < CHAIN_IDS.length; ++i) {
            (address d, address p) = _deployOn(CHAIN_IDS[i]);
            assertEq(d, d1);
            assertEq(p, p1);
        }
    }
}
