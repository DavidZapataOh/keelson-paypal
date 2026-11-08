// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployVerdictVerifier} from "../script/DeployVerdictVerifier.s.sol";
import {VerdictVerifier} from "../src/VerdictVerifier.sol";
import {KeelsonRoles} from "../src/access/KeelsonRoles.sol";
import {ForkTest} from "./utils/Fork.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The deployed VerdictVerifier on every chain whose registry lists it matches its script.
contract VerdictVerifierDeploymentLiveTest is ForkTest {
    using stdJson for string;

    function test_DeployedVerifierMatchesItsScript() public {
        for (uint256 i; i < CHAIN_IDS.length; ++i) {
            string memory json = _jsonOf(CHAIN_IDS[i]);
            if (!vm.keyExistsJson(json, ".contracts.VerdictVerifier")) continue;
            vm.createSelectFork(vm.envString(json.readString(".rpcEnv")));
            DeployVerdictVerifier script = new DeployVerdictVerifier();
            VerdictVerifier verifier = VerdictVerifier(json.readAddress(".contracts.VerdictVerifier"));

            assertEq(address(verifier), script.predict("VerdictVerifier"));
            assertEq(verifier.BOND_VAULT(), script.predict("KeelsonBondVault"));
            assertEq(address(verifier.DCAP_ATTESTATION()), json.readAddress(".external.automataDcapAttestation"));
            assertEq(address(verifier.NITRO_VALIDATOR()), json.readAddress(".contracts.NitroValidator"));
            assertEq(verifier.issuer(), json.readBytes32(".tee.issuerJwkThumbprint"));
            (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
                verifier.eip712Domain();
            assertEq(name, "Keelson");
            assertEq(version, "1");
            assertEq(chainId, CHAIN_IDS[i]);
            assertEq(verifyingContract, address(verifier));

            assertTrue(script.wired(address(verifier)), "roles");
            AccessManager manager = AccessManager(json.readAddress(".contracts.AccessManager"));
            assertEq(manager.getTargetAdminDelay(address(verifier)), json.readUint(".params.signersDelay"));
            assertEq(
                manager.getTargetFunctionRole(address(verifier), VerdictVerifier.setAllowedMeasurement.selector),
                KeelsonRoles.SIGNERS_ROLE
            );
        }
    }
}
