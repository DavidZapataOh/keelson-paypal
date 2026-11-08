// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonDeploy} from "./KeelsonDeploy.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys Base's `nitro-validator` (`P384Verifier`, `CertManager`, `NitroValidator`, in that order) at their
/// CREATE3 addresses, with the bytecode its own audited settings produce (solc 0.8.26, 10,000 optimizer runs).
/// `CertManager` is owned by the timelock and its revoker is the Guardian Safe.
/// @dev Build it first: `forge build --root lib/nitro-validator`.
contract DeployNitroValidator is KeelsonDeploy {
    using stdJson for string;

    struct Nitro {
        address p384Verifier;
        address certManager;
        address validator;
    }

    function run() external returns (Nitro memory nitro) {
        string memory json = _registry();
        vm.startBroadcast(_owner());
        _ensureDeployer();
        nitro.p384Verifier = _deploy("P384Verifier", _artifact("P384Verifier"), "");
        nitro.certManager = _deploy(
            "CertManager",
            _artifact("CertManager"),
            abi.encode(
                nitro.p384Verifier,
                json.readAddress(".contracts.TimelockController"),
                json.readAddress(".contracts.GuardianSafe")
            )
        );
        nitro.validator =
            _deploy("NitroValidator", _artifact("NitroValidator"), abi.encode(nitro.certManager, nitro.p384Verifier));
        vm.stopBroadcast();
    }

    function _artifact(string memory name) internal view returns (bytes memory) {
        return vm.getCode(string.concat("lib/nitro-validator/out/", name, ".sol/", name, ".json"));
    }
}
