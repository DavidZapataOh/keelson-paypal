// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployBaseKmsGovernance} from "../../script/DeployBaseKmsGovernance.s.sol";
import {GuardianSafe} from "../../script/GuardianSafe.sol";
import {AppBootInfo, IDstackApp, IDstackKms} from "../../script/interfaces/IDstack.sol";
import {ISafe} from "../../script/interfaces/ISafe.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";

/// @notice The TDX leg's app on dstack's on-chain KMS on Base, owned by a timelock, from `deployments/8453.json`:
/// run against a Base fork with `BASE_RPC_URL`; skipped without it.
contract BaseKmsGovernanceTest is Test {
    using stdJson for string;

    uint256 internal constant DELAY = 172_800;
    address internal constant PROPOSER = 0x9c0215b66F6a64c34CCb0126Cb8d027689Fa68b9;

    address internal deployer = makeAddr("deployer");
    address internal guardian;
    IDstackApp internal app;
    TimelockController internal timelock;
    string internal json;
    DeployBaseKmsGovernance internal script;
    bytes32 internal constant COMPOSE = keccak256("compose");

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 8453);
        json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/8453.json"));
        vm.prank(deployer);
        app = IDstackApp(
            IDstackKms(json.readAddress(".external.kmsAuth"))
                .deployAndRegisterApp(deployer, false, false, bytes32(0), bytes32(0))
        );
        guardian = address(GuardianSafe.ensure(json));
        script = new DeployBaseKmsGovernance();
        timelock = script.deploy(json, guardian, address(script));
    }

    function test_guardianIsTheTwoOfThreeSafe() public view {
        assertEq(ISafe(guardian).getOwners(), json.readAddressArray(".governance.guardianOwners"));
        assertEq(ISafe(guardian).getThreshold(), 2);
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), guardian));
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), PROPOSER));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)));
        assertEq(timelock.getMinDelay(), DELAY);
    }

    function test_noAdminRemains() public view {
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(script)));
        assertTrue(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(timelock)));
    }

    function bootInfo(bytes32 composeHash) internal view returns (AppBootInfo memory b) {
        b.appId = address(app);
        b.composeHash = composeHash;
        b.deviceId = keccak256("device");
        b.tcbStatus = "UpToDate";
    }

    /// @notice Hands the app to the timelock. The `DstackApp` deployed on Base is single-step `Ownable`: the transfer
    /// takes effect at once, and nothing is left for the timelock to accept.
    function handOver() internal {
        vm.prank(deployer);
        app.transferOwnership(address(timelock));
        assertEq(app.owner(), address(timelock));
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
        uint256 scheduledAt = vm.getBlockTimestamp();
        vm.warp(scheduledAt + DELAY - 1);
        vm.expectRevert();
        timelock.execute(address(app), 0, add, bytes32(0), "add");
        vm.warp(scheduledAt + DELAY);
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
