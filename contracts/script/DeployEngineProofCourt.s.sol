// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {EngineProofCourt} from "../src/EngineProofCourt.sol";
import {KeelsonRoles} from "../src/access/KeelsonRoles.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys the `EngineProofCourt` over the registry's `KeelsonBondVault`, `VerdictVerifier` and
/// `EngineProofVerifier`, and, through the timelock (the AccessManager's admin), grants it `GUARDIAN_ROLE`, which on
/// the vault gates `vetoSlash`.
/// @dev `run()` deploys and schedules the grant; `grant()` executes it once the timelock delay has passed. Both are
/// idempotent. A new `EngineProofVerifier` needs a new court `VERSION`.
contract DeployEngineProofCourt is KeelsonDeploy {
    using stdJson for string;

    string internal constant NAME = "EngineProofCourt";
    string public constant VERSION = "EngineProofCourt/1";

    function run() external returns (EngineProofCourt court) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        court = EngineProofCourt(_deployVersion(NAME, VERSION, type(EngineProofCourt).creationCode, args()));
        if (!_isGuardian(address(court))) {
            TimelockController timelock = _timelock();
            (address target, bytes memory payload) = grantCall(address(court));
            bytes32 id = timelock.hashOperation(target, 0, payload, bytes32(0), _grantSalt());
            if (!timelock.isOperation(id)) {
                timelock.schedule(target, 0, payload, bytes32(0), _grantSalt(), timelock.getMinDelay());
            }
        }
        vm.stopBroadcast();
    }

    function grant() external {
        address court = predict(VERSION);
        if (_isGuardian(court)) return;
        (address target, bytes memory payload) = grantCall(court);
        vm.broadcast(_owner());
        _timelock().execute(target, 0, payload, bytes32(0), _grantSalt());
    }

    function args() public view returns (bytes memory) {
        string memory json = _registry();
        return abi.encode(
            json.readAddress(".contracts.KeelsonBondVault"),
            json.readAddress(".contracts.VerdictVerifier"),
            json.readAddress(".contracts.EngineProofVerifier")
        );
    }

    function grantCall(address court) public view returns (address target, bytes memory payload) {
        target = address(_manager());
        payload = abi.encodeCall(AccessManager.grantRole, (KeelsonRoles.GUARDIAN_ROLE, court, 0));
    }

    function _isGuardian(address court) internal view returns (bool isMember) {
        (isMember,) = _manager().hasRole(KeelsonRoles.GUARDIAN_ROLE, court);
    }

    function _manager() internal view returns (AccessManager) {
        return AccessManager(_registry().readAddress(".contracts.AccessManager"));
    }

    function _timelock() internal view returns (TimelockController) {
        return TimelockController(payable(_registry().readAddress(".contracts.TimelockController")));
    }

    function _grantSalt() internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(RELEASE, "/", VERSION, "/guardian"));
    }
}
