// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Deploy} from "../script/Deploy.s.sol";
import {ISafe} from "../script/interfaces/ISafe.sol";
import {KeelsonRoles} from "../src/access/KeelsonRoles.sol";
import {ManagedTarget} from "./utils/ManagedTarget.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {IAccessManager} from "@openzeppelin/contracts/access/manager/IAccessManager.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test, Vm} from "forge-std/Test.sol";

/// @notice Governance on the local EVM, with Safe v1.5.0's real bytecode copied from Arbitrum Sepolia.
contract GovernanceTest is Test {
    using stdJson for string;

    uint256 internal constant CHAIN_ID = 421614;

    Deploy internal script;
    Deploy.Release internal release;
    AccessManager internal manager;
    TimelockController internal timelock;
    ISafe internal guardian;
    ManagedTarget internal target;
    address internal owner;
    uint256 internal minDelay;
    uint256 internal signersDelay;
    uint256 internal saltCounter;
    Vm.Log[] internal deployLogs;

    function setUp() public {
        vm.chainId(CHAIN_ID);
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/421614.json"));
        _etchFromChain(json, ".external.safeL2");
        _etchFromChain(json, ".external.safeProxyFactory");
        _etchFromChain(json, ".external.safeFallbackHandler");
        owner = json.readAddress(".governance.proposer");
        minDelay = json.readUint(".params.timelockMinDelay");
        signersDelay = json.readUint(".params.signersDelay");

        script = new Deploy();
        vm.recordLogs();
        release = script.run();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            deployLogs.push(logs[i]);
        }
        manager = release.manager;
        timelock = release.timelock;
        guardian = release.guardian;

        target = new ManagedTarget(address(manager));
        _viaTimelock(
            address(manager),
            abi.encodeCall(
                manager.setTargetFunctionRole,
                (address(target), _selectors(target.pause.selector), KeelsonRoles.GUARDIAN_ROLE)
            )
        );
        _viaTimelock(
            address(manager),
            abi.encodeCall(
                manager.setTargetFunctionRole,
                (address(target), _selectors(target.setWindow.selector), KeelsonRoles.PARAMETERS_ROLE)
            )
        );
        _viaTimelock(
            address(manager),
            abi.encodeCall(
                manager.setTargetFunctionRole,
                (address(target), _selectors(target.setSigner.selector), KeelsonRoles.SIGNERS_ROLE)
            )
        );
    }

    function _etchFromChain(string memory json, string memory key) internal {
        address account = json.readAddress(key);
        string memory params = string.concat('["', vm.toString(account), '","latest"]');
        vm.etch(account, vm.rpc(vm.envString(json.readString(".rpcEnv")), "eth_getCode", params));
    }

    function _selectors(bytes4 selector) internal pure returns (bytes4[] memory selectors) {
        selectors = new bytes4[](1);
        selectors[0] = selector;
    }

    function _schedule(address to, bytes memory data) internal returns (bytes32 salt) {
        salt = bytes32(++saltCounter);
        vm.prank(owner);
        timelock.schedule(to, 0, data, bytes32(0), salt, minDelay);
    }

    function _viaTimelock(address to, bytes memory data) internal {
        bytes32 salt = _schedule(to, data);
        vm.warp(vm.getBlockTimestamp() + minDelay);
        timelock.execute(to, 0, data, bytes32(0), salt);
    }

    /// @dev Two owners approve the Safe transaction hash on-chain (Safe's pre-validated signatures) and it executes.
    function _guardianExec(address to, bytes memory data) internal {
        bytes32 safeTxHash = guardian.getTransactionHash(
            to, 0, data, ISafe.Operation.Call, 0, 0, 0, address(0), address(0), guardian.nonce()
        );
        address[] memory owners = guardian.getOwners();
        (address a, address b) = owners[0] < owners[1] ? (owners[0], owners[1]) : (owners[1], owners[0]);
        vm.prank(a);
        guardian.approveHash(safeTxHash);
        vm.prank(b);
        guardian.approveHash(safeTxHash);
        bytes memory signatures = abi.encodePacked(
            bytes32(uint256(uint160(a))), bytes32(0), uint8(1), bytes32(uint256(uint160(b))), bytes32(0), uint8(1)
        );
        assertTrue(
            guardian.execTransaction(
                to, 0, data, ISafe.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signatures
            )
        );
    }

    function _netHolders(address emitter, bytes32 grantedTopic, bytes32 revokedTopic, bytes32 role)
        internal
        view
        returns (address[] memory holders, uint256 count)
    {
        holders = new address[](deployLogs.length);
        for (uint256 i; i < deployLogs.length; ++i) {
            Vm.Log memory log = deployLogs[i];
            if (log.emitter != emitter || log.topics.length < 3 || log.topics[1] != role) continue;
            address account = address(uint160(uint256(log.topics[2])));
            if (log.topics[0] == grantedTopic) {
                holders[count++] = account;
            } else if (log.topics[0] == revokedTopic) {
                for (uint256 j; j < count; ++j) {
                    if (holders[j] == account) holders[j] = holders[--count];
                }
            }
        }
    }

    function test_TimelockIsOnlyAdmin() public view {
        (bool isAdmin, uint32 delay) = manager.hasRole(KeelsonRoles.ADMIN_ROLE, address(timelock));
        assertTrue(isAdmin);
        assertEq(delay, 0);
        (isAdmin,) = manager.hasRole(KeelsonRoles.ADMIN_ROLE, owner);
        assertFalse(isAdmin);

        (address[] memory holders, uint256 count) = _netHolders(
            address(manager),
            IAccessManager.RoleGranted.selector,
            IAccessManager.RoleRevoked.selector,
            bytes32(uint256(KeelsonRoles.ADMIN_ROLE))
        );
        assertEq(count, 1);
        assertEq(holders[0], address(timelock));

        bytes32 adminRole = timelock.DEFAULT_ADMIN_ROLE();
        (holders, count) = _netHolders(
            address(timelock),
            keccak256("RoleGranted(bytes32,address,address)"),
            keccak256("RoleRevoked(bytes32,address,address)"),
            adminRole
        );
        assertEq(count, 1);
        assertEq(holders[0], address(timelock));
        assertFalse(timelock.hasRole(adminRole, owner));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), address(guardian)));
    }

    function test_GuardianPausesImmediately() public {
        _guardianExec(address(target), abi.encodeCall(target.pause, ()));
        assertTrue(target.paused());
    }

    function test_RevertWhen_GuardianGrantsRole() public {
        vm.prank(address(guardian));
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessManager.AccessManagerUnauthorizedAccount.selector, address(guardian), KeelsonRoles.ADMIN_ROLE
            )
        );
        manager.grantRole(KeelsonRoles.PARAMETERS_ROLE, address(guardian), 0);
    }

    function test_RevertWhen_AdminActionSkipsTimelock() public {
        bytes memory data = abi.encodeCall(
            manager.setTargetFunctionRole,
            (address(target), _selectors(target.pause.selector), KeelsonRoles.PUBLIC_ROLE)
        );
        bytes32 salt = _schedule(address(manager), data);
        vm.warp(vm.getBlockTimestamp() + minDelay - 1);
        vm.expectRevert();
        timelock.execute(address(manager), 0, data, bytes32(0), salt);

        vm.warp(vm.getBlockTimestamp() + 1);
        timelock.execute(address(manager), 0, data, bytes32(0), salt);
        assertEq(manager.getTargetFunctionRole(address(target), target.pause.selector), KeelsonRoles.PUBLIC_ROLE);
    }

    function test_SignersActionWaitsBothDelays() public {
        address signer = makeAddr("signer");
        bytes memory call = abi.encodeCall(target.setSigner, (signer));
        _viaTimelock(address(manager), abi.encodeCall(manager.schedule, (address(target), call, 0)));

        bytes32 salt = _schedule(address(target), call);
        vm.warp(vm.getBlockTimestamp() + minDelay);
        assertLt(minDelay, signersDelay);
        vm.expectRevert();
        timelock.execute(address(target), 0, call, bytes32(0), salt);

        vm.warp(vm.getBlockTimestamp() + signersDelay - minDelay - 1);
        vm.expectRevert();
        timelock.execute(address(target), 0, call, bytes32(0), salt);

        vm.warp(vm.getBlockTimestamp() + 1);
        timelock.execute(address(target), 0, call, bytes32(0), salt);
        assertEq(target.signer(), signer);
    }

    function test_SignersActionRevertsNotReady() public {
        bytes memory call = abi.encodeCall(target.setSigner, (makeAddr("signer")));
        _viaTimelock(address(manager), abi.encodeCall(manager.schedule, (address(target), call, 0)));
        bytes32 id = manager.hashOperation(address(timelock), address(target), call);
        vm.prank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(IAccessManager.AccessManagerNotReady.selector, id));
        target.setSigner(makeAddr("signer"));
    }

    function test_GuardianCancelsTimelockOperation() public {
        bytes memory data = abi.encodeCall(target.setWindow, (7));
        bytes32 salt = _schedule(address(target), data);
        bytes32 id = timelock.hashOperation(address(target), 0, data, bytes32(0), salt);
        assertTrue(timelock.isOperationPending(id));

        _guardianExec(address(timelock), abi.encodeCall(timelock.cancel, (id)));

        assertFalse(timelock.isOperation(id));
        vm.warp(vm.getBlockTimestamp() + minDelay);
        vm.expectRevert();
        timelock.execute(address(target), 0, data, bytes32(0), salt);
    }

    function test_RedeployIsIdempotent() public {
        vm.recordLogs();
        Deploy.Release memory again = script.run();
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(address(again.deployer), address(release.deployer));
        assertEq(address(again.manager), address(manager));
        assertEq(address(again.timelock), address(timelock));
        assertEq(address(again.guardian), address(guardian));
    }
}
