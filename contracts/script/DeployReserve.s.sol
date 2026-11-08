// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonReserve} from "../src/KeelsonReserve.sol";
import {KeelsonRoles} from "../src/access/KeelsonRoles.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys the `KeelsonReserve` at its CREATE3 address, the one the vault has sent premiums to from its first
/// coverage, and wires `setCooldown` and `setRateLimit` to `PARAMETERS_ROLE` through the timelock.
/// @dev `run()` deploys and schedules the wiring; `wire()` executes it once the timelock delay has passed. Both are
/// idempotent.
contract DeployReserve is KeelsonDeploy {
    using stdJson for string;

    string internal constant NAME = "KeelsonReserve";

    function run() external returns (KeelsonReserve reserve) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        reserve = KeelsonReserve(_deploy(NAME, type(KeelsonReserve).creationCode, constructorArgs()));
        if (!wired()) {
            TimelockController timelock = _timelock();
            bytes memory payload = _wiring();
            address manager = address(_manager());
            if (!timelock.isOperation(timelock.hashOperation(manager, 0, payload, bytes32(0), _wiringSalt()))) {
                timelock.schedule(manager, 0, payload, bytes32(0), _wiringSalt(), timelock.getMinDelay());
            }
        }
        vm.stopBroadcast();
    }

    function wire() external {
        if (wired()) return;
        vm.broadcast(_owner());
        _timelock().execute(address(_manager()), 0, _wiring(), bytes32(0), _wiringSalt());
    }

    /// @notice `(pyusd, verifier, anchor, vault, logOrigin, authority, cooldown, unstakeWindow, rateLimitWindow,
    /// rateLimitCapacity)`: the chain's PYUSD, the `VerdictVerifier`, `CheckpointAnchor` and `KeelsonBondVault`
    /// CREATE3 addresses, and the registry's log origin, cooldown and warranty rate limit.
    function constructorArgs() public view returns (bytes memory) {
        string memory json = _registry();
        return abi.encode(
            json.readAddress(".external.pyusd"),
            predict("VerdictVerifier"),
            predict("CheckpointAnchor"),
            predict("KeelsonBondVault"),
            keccak256(bytes(json.readString(".params.logOrigin"))),
            json.readAddress(".contracts.AccessManager"),
            uint40(json.readUint(".params.reserveCooldown")),
            uint40(json.readUint(".params.reserveUnstakeWindow")),
            uint48(json.readUint(".params.warrantyRateWindow")),
            uint208(json.readUint(".params.warrantyRateCapacity"))
        );
    }

    function wired() public view returns (bool) {
        AccessManager manager = _manager();
        return manager.getTargetFunctionRole(predict(NAME), KeelsonReserve.setCooldown.selector)
                == KeelsonRoles.PARAMETERS_ROLE
            && manager.getTargetFunctionRole(predict(NAME), KeelsonReserve.setRateLimit.selector)
                == KeelsonRoles.PARAMETERS_ROLE;
    }

    function _wiring() internal view returns (bytes memory) {
        bytes4[] memory parameters = new bytes4[](2);
        parameters[0] = KeelsonReserve.setCooldown.selector;
        parameters[1] = KeelsonReserve.setRateLimit.selector;
        return
            abi.encodeCall(
                AccessManager.setTargetFunctionRole, (predict(NAME), parameters, KeelsonRoles.PARAMETERS_ROLE)
            );
    }

    function _wiringSalt() internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(RELEASE, "/", NAME, "/roles"));
    }

    function _manager() internal view returns (AccessManager) {
        return AccessManager(_registry().readAddress(".contracts.AccessManager"));
    }

    function _timelock() internal view returns (TimelockController) {
        return TimelockController(payable(_registry().readAddress(".contracts.TimelockController")));
    }
}
