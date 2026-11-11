// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {AppBootInfo, IDstackApp, IDstackKms} from "../../script/interfaces/IDstack.sol";
import {DeployBaseKmsGovernance} from "../../script/DeployBaseKmsGovernance.s.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The TDX leg's app on dstack's on-chain KMS on Base, owned by a timelock: run against a Base fork with
/// `BASE_RPC_URL` and `KMS_AUTH` (the `DstackKms` Phala Cloud's on-chain KMS uses); skipped without them.
contract BaseKmsGovernanceTest is Test {
    uint256 internal constant DELAY = 172_800;
    address internal constant PROPOSER = 0x9c0215b66F6a64c34CCb0126Cb8d027689Fa68b9;

    address internal deployer = makeAddr("deployer");
    address internal guardian = makeAddr("guardian");
    IDstackApp internal app;
    TimelockController internal timelock;
    bytes32 internal constant COMPOSE = keccak256("compose");

    function setUp() public {
        address kms = vm.envOr("KMS_AUTH", address(0));
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (kms == address(0) || bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 8453);
        vm.prank(deployer);
        app = IDstackApp(IDstackKms(kms).deployAndRegisterApp(deployer, false, false, bytes32(0), bytes32(0)));
        timelock = new DeployBaseKmsGovernance().deploy(PROPOSER, guardian, address(this));
    }

    function bootInfo(bytes32 composeHash) internal view returns (AppBootInfo memory b) {
        b.appId = address(app);
        b.composeHash = composeHash;
        b.deviceId = keccak256("device");
        b.tcbStatus = "UpToDate";
    }

    /// @notice Hands the app to the timelock: staged by the deployer, accepted by the timelock after the delay.
    function handOver() internal {
        vm.prank(deployer);
        app.transferOwnership(address(timelock));
        schedule(abi.encodeCall(IDstackApp.acceptOwnership, ()), bytes32("accept"));
        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(app), 0, abi.encodeCall(IDstackApp.acceptOwnership, ()), bytes32(0), "accept");
    }

    function schedule(bytes memory data, bytes32 salt) internal {
        vm.prank(PROPOSER);
        timelock.schedule(address(app), 0, data, bytes32(0), salt, DELAY);
    }

    function test_bootstrapAppAllowsNothing() public view {
        (bool allowed, string memory reason) = app.isAppAllowed(bootInfo(COMPOSE));
        assertFalse(allowed);
        assertEq(reason, "Compose hash not allowed");
    }

    function test_eoaCannotAddComposeAfterHandOver() public {
        handOver();
        assertEq(app.owner(), address(timelock));
        vm.prank(deployer);
        vm.expectRevert();
        app.addComposeHash(COMPOSE);
    }

    function test_timelockAddsComposeAfterDelay() public {
        handOver();
        bytes memory add = abi.encodeCall(IDstackApp.addComposeHash, (COMPOSE));
        schedule(add, bytes32("add"));
        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert();
        timelock.execute(address(app), 0, add, bytes32(0), "add");
        vm.warp(block.timestamp + 1);
        timelock.execute(address(app), 0, add, bytes32(0), "add");
        (, string memory reason) = app.isAppAllowed(bootInfo(COMPOSE));
        assertTrue(keccak256(bytes(reason)) != keccak256("Compose hash not allowed"));
    }

    function test_guardianCancels() public {
        handOver();
        bytes memory add = abi.encodeCall(IDstackApp.addComposeHash, (COMPOSE));
        schedule(add, bytes32("add"));
        bytes32 id = timelock.hashOperation(address(app), 0, add, bytes32(0), bytes32("add"));
        vm.prank(guardian);
        timelock.cancel(id);
        assertFalse(timelock.isOperation(id));
    }
}
