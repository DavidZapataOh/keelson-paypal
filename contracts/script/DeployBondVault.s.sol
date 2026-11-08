// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonBondVault} from "../src/KeelsonBondVault.sol";
import {KeelsonRoles} from "../src/access/KeelsonRoles.sol";
import {IKeelsonBondVault} from "../src/interfaces/IKeelsonBondVault.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys a `KeelsonBondVault` at the CREATE3 address of `name` and wires its roles through the timelock:
/// `setParams` and `setRateLimit` take `PARAMETERS_ROLE`; `pause`, `unpause` and `vetoSlash` take `GUARDIAN_ROLE`.
/// @dev `run(name)` deploys and schedules the wiring; `wire(name)` executes it once the timelock delay has passed. Both
/// are idempotent. A CREATE3 address depends only on the salt, so a vault deployed under another name leaves the
/// `KeelsonBondVault` address (which the TEE legs' attestations bind) free.
contract DeployBondVault is KeelsonDeploy {
    using stdJson for string;

    function run(string calldata name) external returns (KeelsonBondVault vault) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        vault = KeelsonBondVault(_deploy(name, type(KeelsonBondVault).creationCode, constructorArgs()));
        if (!wired(address(vault))) {
            (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = wiring(address(vault));
            TimelockController timelock = _timelock();
            bytes32 id = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), _wiringSalt(name));
            if (!timelock.isOperation(id)) {
                timelock.scheduleBatch(targets, values, payloads, bytes32(0), _wiringSalt(name), timelock.getMinDelay());
            }
        }
        vm.stopBroadcast();
    }

    function wire(string calldata name) external {
        address vault = predict(name);
        if (wired(vault)) return;
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = wiring(vault);
        vm.broadcast(_owner());
        _timelock().executeBatch(targets, values, payloads, bytes32(0), _wiringSalt(name));
    }

    /// @notice `(pyusd, verifier, anchor, identity, reserve, logOrigin, rpIdHash, authority, params, rateLimitWindow,
    /// rateLimitCapacity)`: the chain's PYUSD and ERC-8004 Identity, the `VerdictVerifier`, `CheckpointAnchor` and
    /// `KeelsonReserve` CREATE3 addresses, the registry's log origin and parameters, and the passkeys' RP ID
    /// `keelson.finance`.
    function constructorArgs() public view returns (bytes memory) {
        string memory json = _registry();
        (uint48 window, uint208 capacity) = rateLimit();
        return abi.encode(
            json.readAddress(".external.pyusd"),
            predict("VerdictVerifier"),
            predict("CheckpointAnchor"),
            json.readAddress(".external.erc8004Identity"),
            predict("KeelsonReserve"),
            keccak256(bytes(json.readString(".params.logOrigin"))),
            sha256("keelson.finance"),
            json.readAddress(".contracts.AccessManager"),
            params(),
            window,
            capacity
        );
    }

    /// @notice The PYUSD that slashes may pay out per window before they queue.
    function rateLimit() public view returns (uint48 window, uint208 capacity) {
        string memory json = _registry();
        return (uint48(json.readUint(".params.slashRateWindow")), uint208(json.readUint(".params.slashRateCapacity")));
    }

    function params() public view returns (IKeelsonBondVault.Params memory) {
        string memory json = _registry();
        return IKeelsonBondVault.Params({
            disputeWindow: uint40(json.readUint(".params.disputeWindow")),
            vetoWindow: uint40(json.readUint(".params.vetoWindow")),
            grace: uint40(json.readUint(".params.grace")),
            withdrawalDelay: uint40(json.readUint(".params.withdrawalDelay")),
            instantSlashCap: uint96(json.readUint(".params.instantSlashCap"))
        });
    }

    function wiring(address vault)
        public
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        AccessManager manager = _manager();
        bytes4[] memory parameters = new bytes4[](2);
        parameters[0] = KeelsonBondVault.setParams.selector;
        parameters[1] = KeelsonBondVault.setRateLimit.selector;
        bytes4[] memory guardian = new bytes4[](3);
        guardian[0] = KeelsonBondVault.pause.selector;
        guardian[1] = KeelsonBondVault.unpause.selector;
        guardian[2] = KeelsonBondVault.vetoSlash.selector;

        targets = new address[](2);
        values = new uint256[](2);
        payloads = new bytes[](2);
        targets[0] = targets[1] = address(manager);
        payloads[0] = abi.encodeCall(manager.setTargetFunctionRole, (vault, parameters, KeelsonRoles.PARAMETERS_ROLE));
        payloads[1] = abi.encodeCall(manager.setTargetFunctionRole, (vault, guardian, KeelsonRoles.GUARDIAN_ROLE));
    }

    function wired(address vault) public view returns (bool) {
        AccessManager manager = _manager();
        return manager.getTargetFunctionRole(vault, KeelsonBondVault.setParams.selector) == KeelsonRoles.PARAMETERS_ROLE
            && manager.getTargetFunctionRole(vault, KeelsonBondVault.setRateLimit.selector)
                == KeelsonRoles.PARAMETERS_ROLE
            && manager.getTargetFunctionRole(vault, KeelsonBondVault.pause.selector) == KeelsonRoles.GUARDIAN_ROLE
            && manager.getTargetFunctionRole(vault, KeelsonBondVault.unpause.selector) == KeelsonRoles.GUARDIAN_ROLE
            && manager.getTargetFunctionRole(vault, KeelsonBondVault.vetoSlash.selector) == KeelsonRoles.GUARDIAN_ROLE;
    }

    function _wiringSalt(string calldata name) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(RELEASE, "/", name, "/roles"));
    }

    function _manager() internal view returns (AccessManager) {
        return AccessManager(_registry().readAddress(".contracts.AccessManager"));
    }

    function _timelock() internal view returns (TimelockController) {
        return TimelockController(payable(_registry().readAddress(".contracts.TimelockController")));
    }
}
