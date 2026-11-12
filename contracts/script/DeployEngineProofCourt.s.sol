// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {EngineProofCourt} from "../src/EngineProofCourt.sol";
import {KeelsonBondVault} from "../src/KeelsonBondVault.sol";
import {KeelsonRoles} from "../src/access/KeelsonRoles.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys the `EngineProofCourt` over the registry's `KeelsonBondVault`, `VerdictVerifier`,
/// `KeelsonValidationRegistry` and `EngineProofVerifier`, and, through the timelock (the AccessManager's admin), moves
/// the vault's `vetoSlash` from `GUARDIAN_ROLE` to `VETO_ROLE`, held by the Guardian Safe and the court. The court can
/// veto a slash and nothing else; the Guardian keeps its veto and its pause.
/// @dev `run()` deploys and schedules the batch; `grant()` executes it once the timelock delay has passed. Both are
/// idempotent. A new `EngineProofVerifier` needs a new court `VERSION`, granted and the earlier one revoked.
contract DeployEngineProofCourt is KeelsonDeploy {
    using stdJson for string;

    string internal constant NAME = "EngineProofCourt";
    /// @notice Over `EngineProofVerifier/8`.
    string public constant VERSION = "EngineProofCourt/3";

    function run() external returns (EngineProofCourt court) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        court = EngineProofCourt(_deployVersion(NAME, VERSION, type(EngineProofCourt).creationCode, args()));
        if (!granted(address(court))) {
            (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = grants(address(court));
            TimelockController timelock = _timelock();
            bytes32 id = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), _grantSalt());
            if (!timelock.isOperation(id)) {
                timelock.scheduleBatch(targets, values, payloads, bytes32(0), _grantSalt(), timelock.getMinDelay());
            }
        }
        vm.stopBroadcast();
    }

    function grant() external {
        address court = predict(VERSION);
        if (granted(court)) return;
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = grants(court);
        vm.broadcast(_owner());
        _timelock().executeBatch(targets, values, payloads, bytes32(0), _grantSalt());
    }

    function args() public view returns (bytes memory) {
        string memory json = _registry();
        return abi.encode(
            json.readAddress(".contracts.KeelsonBondVault"),
            json.readAddress(".contracts.VerdictVerifier"),
            json.readAddress(".contracts.KeelsonValidationRegistry"),
            json.readAddress(".contracts.EngineProofVerifier")
        );
    }

    /// @notice The AccessManager calls: label `VETO_ROLE`, grant it to the Guardian Safe and the court, and map
    /// `vetoSlash` to it, in that order so the Guardian never loses the veto.
    function grants(address court)
        public
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        AccessManager manager = _manager();
        string memory json = _registry();
        bytes4[] memory veto = new bytes4[](1);
        veto[0] = KeelsonBondVault.vetoSlash.selector;
        targets = new address[](4);
        values = new uint256[](4);
        payloads = new bytes[](4);
        for (uint256 i; i < 4; ++i) {
            targets[i] = address(manager);
        }
        payloads[0] = abi.encodeCall(AccessManager.labelRole, (KeelsonRoles.VETO_ROLE, "VETO"));
        payloads[1] = abi.encodeCall(
            AccessManager.grantRole, (KeelsonRoles.VETO_ROLE, json.readAddress(".contracts.GuardianSafe"), 0)
        );
        payloads[2] = abi.encodeCall(AccessManager.grantRole, (KeelsonRoles.VETO_ROLE, court, 0));
        payloads[3] = abi.encodeCall(
            AccessManager.setTargetFunctionRole,
            (json.readAddress(".contracts.KeelsonBondVault"), veto, KeelsonRoles.VETO_ROLE)
        );
    }

    function granted(address court) public view returns (bool) {
        AccessManager manager = _manager();
        (bool isMember,) = manager.hasRole(KeelsonRoles.VETO_ROLE, court);
        return isMember
            && manager.getTargetFunctionRole(
                _registry().readAddress(".contracts.KeelsonBondVault"), KeelsonBondVault.vetoSlash.selector
            ) == KeelsonRoles.VETO_ROLE;
    }

    function _manager() internal view returns (AccessManager) {
        return AccessManager(_registry().readAddress(".contracts.AccessManager"));
    }

    function _timelock() internal view returns (TimelockController) {
        return TimelockController(payable(_registry().readAddress(".contracts.TimelockController")));
    }

    function _grantSalt() internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(RELEASE, "/", VERSION, "/veto"));
    }
}
