// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonDeployer} from "../src/deploy/KeelsonDeployer.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Errors} from "@openzeppelin/contracts/utils/Errors.sol";
import {Test} from "forge-std/Test.sol";

contract Box {
    uint256 public immutable value;

    constructor(uint256 value_) {
        value = value_;
    }
}

contract Other {
    function hello() external pure returns (string memory) {
        return "hello";
    }
}

contract KeelsonDeployerTest is Test {
    address internal constant OWNER = address(0xA11CE);

    KeelsonDeployer internal deployer;

    function setUp() public {
        deployer = new KeelsonDeployer(OWNER);
    }

    function _deploy(bytes32 salt, bytes memory initCode) internal returns (address) {
        vm.prank(OWNER);
        return deployer.deploy(salt, initCode);
    }

    function test_PredictMatchesDeploy() public {
        bytes32 a = keccak256("a");
        bytes32 b = keccak256("b");
        address boxAt = deployer.predict(a);
        address otherAt = deployer.predict(b);
        assertNotEq(boxAt, otherAt);

        vm.expectEmit(address(deployer));
        emit KeelsonDeployer.Deployed(a, boxAt);
        assertEq(_deploy(a, abi.encodePacked(type(Box).creationCode, abi.encode(7))), boxAt);
        assertEq(_deploy(b, type(Other).creationCode), otherAt);
        assertEq(Box(boxAt).value(), 7);
        assertEq(Other(otherAt).hello(), "hello");
    }

    function test_AddressIgnoresInitCode() public {
        bytes32 s = keccak256("s");
        uint256 snapshot = vm.snapshotState();
        address first = _deploy(s, abi.encodePacked(type(Box).creationCode, abi.encode(1)));
        vm.revertToState(snapshot);
        address second = _deploy(s, abi.encodePacked(type(Box).creationCode, abi.encode(2)));
        assertEq(first, second);
        assertEq(Box(second).value(), 2);
    }

    function test_RevertWhen_NotOwner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(KeelsonDeployer.Unauthorized.selector);
        deployer.deploy(keccak256("s"), type(Other).creationCode);
    }

    function test_RevertWhen_SaltReused() public {
        bytes32 s = keccak256("s");
        _deploy(s, type(Other).creationCode);
        vm.prank(OWNER);
        vm.expectRevert(Errors.FailedDeployment.selector);
        deployer.deploy(s, type(Other).creationCode);
    }

    function test_OtherOwnerOtherAddresses() public {
        bytes memory ours = abi.encodePacked(type(KeelsonDeployer).creationCode, abi.encode(OWNER));
        bytes memory theirs = abi.encodePacked(type(KeelsonDeployer).creationCode, abi.encode(address(0xBAD)));
        address mine = _viaFactory(ours);
        address other = _viaFactory(theirs);
        assertNotEq(mine, other);
        assertNotEq(KeelsonDeployer(mine).predict(keccak256("s")), KeelsonDeployer(other).predict(keccak256("s")));
        assertEq(KeelsonDeployer(mine).owner(), OWNER);
    }

    function _viaFactory(bytes memory initCode) internal returns (address deployed) {
        (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(bytes32(0), initCode));
        assertTrue(ok);
        deployed = address(bytes20(ret));
        assertEq(deployed, Create2.computeAddress(bytes32(0), keccak256(initCode), CREATE2_FACTORY));
    }
}
