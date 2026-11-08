// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {VerdictVerifier} from "../src/VerdictVerifier.sol";
import {KeelsonRoles} from "../src/access/KeelsonRoles.sol";
import {IAutomataDcapAttestation} from "../src/interfaces/IAutomataDcapAttestation.sol";
import {INitroValidator} from "../src/interfaces/INitroValidator.sol";
import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys the `VerdictVerifier` at its CREATE3 address and wires its roles in the AccessManager through the
/// timelock: allowing measurements and setting the issuer take `SIGNERS_ROLE` (timelock, then the signers delay),
/// revoking a signer takes `GUARDIAN_ROLE` (no delay).
/// @dev `run()` deploys and schedules the wiring; `wire()` executes it once the timelock delay has passed. Both are
/// idempotent.
contract DeployVerdictVerifier is KeelsonDeploy {
    using stdJson for string;

    bytes32 internal constant WIRING_SALT = keccak256("keelson/v1/VerdictVerifier/roles");

    function run() external returns (VerdictVerifier verifier) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        verifier = VerdictVerifier(_deploy("VerdictVerifier", type(VerdictVerifier).creationCode, constructorArgs()));
        if (!wired(address(verifier))) {
            (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = wiring(address(verifier));
            TimelockController timelock = _timelock();
            bytes32 id = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), WIRING_SALT);
            if (!timelock.isOperation(id)) {
                timelock.scheduleBatch(targets, values, payloads, bytes32(0), WIRING_SALT, timelock.getMinDelay());
            }
        }
        vm.stopBroadcast();
    }

    function wire() external {
        address verifier = predict("VerdictVerifier");
        if (wired(verifier)) return;
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = wiring(verifier);
        vm.broadcast(_owner());
        _timelock().executeBatch(targets, values, payloads, bytes32(0), WIRING_SALT);
    }

    /// @notice `(authority, bondVault, issuer, initialMeasurements, dcapAttestation, nitroValidator)`: the measurements
    /// of `engine/tee/measurements.json`, the issuer of the registry and the Nitro validator deployed before.
    function constructorArgs() public view returns (bytes memory) {
        string memory json = _registry();
        return abi.encode(
            json.readAddress(".contracts.AccessManager"),
            predict("KeelsonBondVault"),
            json.readBytes32(".tee.issuerJwkThumbprint"),
            initialMeasurements(),
            IAutomataDcapAttestation(json.readAddress(".external.automataDcapAttestation")),
            INitroValidator(json.readAddress(".contracts.NitroValidator"))
        );
    }

    /// @notice The TDX and Nitro ids of the engine build the legs run, as `bytes32`.
    function initialMeasurements() public view returns (bytes32[] memory measurements) {
        string memory m = vm.readFile(string.concat(vm.projectRoot(), "/../engine/tee/measurements.json"));
        measurements = new bytes32[](2);
        measurements[0] = _id(m.readString(".tdx.id"), "tdx:");
        measurements[1] = _id(m.readString(".nitro.id"), "nitro:");
    }

    function wiring(address verifier)
        public
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        AccessManager manager = AccessManager(_registry().readAddress(".contracts.AccessManager"));
        bytes4[] memory signers = new bytes4[](2);
        signers[0] = VerdictVerifier.setAllowedMeasurement.selector;
        signers[1] = VerdictVerifier.setIssuer.selector;
        bytes4[] memory guardian = new bytes4[](2);
        guardian[0] = VerdictVerifier.revokeSigner.selector;
        guardian[1] = VerdictVerifier.disallowMeasurement.selector;

        targets = new address[](3);
        values = new uint256[](3);
        payloads = new bytes[](3);
        targets[0] = targets[1] = targets[2] = address(manager);
        payloads[0] = abi.encodeCall(manager.setTargetFunctionRole, (verifier, signers, KeelsonRoles.SIGNERS_ROLE));
        payloads[1] = abi.encodeCall(manager.setTargetFunctionRole, (verifier, guardian, KeelsonRoles.GUARDIAN_ROLE));
        // Without it the admin could re-map the SIGNERS functions to a role with no delay.
        payloads[2] = abi.encodeCall(
            manager.setTargetAdminDelay, (verifier, uint32(_registry().readUint(".params.signersDelay")))
        );
    }

    function wired(address verifier) public view returns (bool) {
        AccessManager manager = AccessManager(_registry().readAddress(".contracts.AccessManager"));
        return manager.getTargetFunctionRole(verifier, VerdictVerifier.setAllowedMeasurement.selector)
                == KeelsonRoles.SIGNERS_ROLE
            && manager.getTargetFunctionRole(verifier, VerdictVerifier.setIssuer.selector) == KeelsonRoles.SIGNERS_ROLE
            && manager.getTargetFunctionRole(verifier, VerdictVerifier.revokeSigner.selector)
                == KeelsonRoles.GUARDIAN_ROLE
            && manager.getTargetFunctionRole(verifier, VerdictVerifier.disallowMeasurement.selector)
                == KeelsonRoles.GUARDIAN_ROLE;
    }

    function _timelock() internal view returns (TimelockController) {
        return TimelockController(payable(_registry().readAddress(".contracts.TimelockController")));
    }

    function _id(string memory id, string memory prefix) internal pure returns (bytes32) {
        require(vm.indexOf(id, prefix) == 0, "measurement prefix");
        return vm.parseBytes32(vm.replace(id, prefix, "0x"));
    }
}
