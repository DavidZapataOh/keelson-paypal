// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IAnonymousMandateVerifier, RegisteredUserSet} from "../src/RegisteredUserSet.sol";
import {KeelsonRoles} from "../src/access/KeelsonRoles.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys the `RegisteredUserSet` at its CREATE3 address over the registry's AccessManager and C3 verifier,
/// and wires `publish` to `PUBLISHER_ROLE`, granted to the registry's relayer, and `revoke` to `GUARDIAN_ROLE`, through
/// the timelock.
/// @dev `run()` deploys and schedules the wiring; `wire()` executes it once the timelock delay has passed. Both are
/// idempotent. The wiring's salt names the relayer, so a new relayer in the registry schedules a new grant; revoking
/// the old one is a separate timelock operation.
contract DeployRegisteredUserSet is KeelsonDeploy {
    using stdJson for string;

    string internal constant NAME = "RegisteredUserSet";

    function run() external returns (RegisteredUserSet users) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        users = RegisteredUserSet(_deploy(NAME, type(RegisteredUserSet).creationCode, constructorArgs()));
        if (!wired()) {
            TimelockController timelock = _timelock();
            (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _wiring();
            bytes32 id = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), _wiringSalt());
            if (!timelock.isOperation(id)) {
                timelock.scheduleBatch(targets, values, payloads, bytes32(0), _wiringSalt(), timelock.getMinDelay());
            }
        }
        vm.stopBroadcast();
    }

    error WiringUndone();

    function wire() external {
        if (wired()) return;
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = _wiring();
        // The batch ran and a later operation took a role back: this script cannot redo it.
        if (_timelock()
                .isOperationDone(_timelock().hashOperationBatch(targets, values, payloads, bytes32(0), _wiringSalt()))) revert WiringUndone();
        vm.broadcast(_owner());
        _timelock().executeBatch(targets, values, payloads, bytes32(0), _wiringSalt());
    }

    /// @notice `(authority, verifier)`: the registry's AccessManager and `AnonymousMandateVerifier`.
    function constructorArgs() public view returns (bytes memory) {
        string memory json = _registry();
        return abi.encode(
            json.readAddress(".contracts.AccessManager"),
            IAnonymousMandateVerifier(json.readAddress(".contracts.AnonymousMandateVerifier"))
        );
    }

    function wired() public view returns (bool) {
        AccessManager manager = _manager();
        (bool member,) = manager.hasRole(KeelsonRoles.PUBLISHER_ROLE, relayer());
        return member
            && manager.getTargetFunctionRole(predict(NAME), RegisteredUserSet.publish.selector)
                == KeelsonRoles.PUBLISHER_ROLE
            && manager.getTargetFunctionRole(predict(NAME), RegisteredUserSet.revoke.selector)
                == KeelsonRoles.GUARDIAN_ROLE;
    }

    /// @notice The relayer's sender on this chain, the only `PUBLISHER_ROLE` member.
    function relayer() public view returns (address) {
        return _registry().readAddress(".relayer");
    }

    function _wiring()
        internal
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        address manager = address(_manager());
        bytes4[] memory publish = new bytes4[](1);
        publish[0] = RegisteredUserSet.publish.selector;
        bytes4[] memory revoke = new bytes4[](1);
        revoke[0] = RegisteredUserSet.revoke.selector;
        targets = new address[](3);
        values = new uint256[](3);
        payloads = new bytes[](3);
        (targets[0], targets[1], targets[2]) = (manager, manager, manager);
        payloads[0] =
            abi.encodeCall(AccessManager.setTargetFunctionRole, (predict(NAME), publish, KeelsonRoles.PUBLISHER_ROLE));
        payloads[1] =
            abi.encodeCall(AccessManager.setTargetFunctionRole, (predict(NAME), revoke, KeelsonRoles.GUARDIAN_ROLE));
        payloads[2] = abi.encodeCall(AccessManager.grantRole, (KeelsonRoles.PUBLISHER_ROLE, relayer(), 0));
    }

    function _wiringSalt() internal view returns (bytes32) {
        return keccak256(abi.encodePacked(RELEASE, "/", NAME, "/roles/", relayer()));
    }

    function _manager() internal view returns (AccessManager) {
        return AccessManager(_registry().readAddress(".contracts.AccessManager"));
    }

    function _timelock() internal view returns (TimelockController) {
        return TimelockController(payable(_registry().readAddress(".contracts.TimelockController")));
    }
}
