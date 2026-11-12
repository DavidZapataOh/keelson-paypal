// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DeployAmberContradictionCourt} from "../script/DeployAmberContradictionCourt.s.sol";
import {DeployBondVault} from "../script/DeployBondVault.s.sol";
import {DeployCheckpointAnchor} from "../script/DeployCheckpointAnchor.s.sol";
import {DeployErc8004} from "../script/DeployErc8004.s.sol";
import {DeployMandateViolationCourt} from "../script/DeployMandateViolationCourt.s.sol";
import {DeployReserve} from "../script/DeployReserve.s.sol";
import {DeployVerdictVerifier} from "../script/DeployVerdictVerifier.s.sol";
import {DeployViolationBondPool} from "../script/DeployViolationBondPool.s.sol";
import {AmberContradictionCourt} from "../src/AmberContradictionCourt.sol";
import {CheckpointAnchor} from "../src/CheckpointAnchor.sol";
import {KeelsonBondVault} from "../src/KeelsonBondVault.sol";
import {KeelsonReputationReporter} from "../src/KeelsonReputationReporter.sol";
import {KeelsonReserve} from "../src/KeelsonReserve.sol";
import {KeelsonValidationRegistry} from "../src/KeelsonValidationRegistry.sol";
import {MandateViolationCourt} from "../src/MandateViolationCourt.sol";
import {VerdictVerifier} from "../src/VerdictVerifier.sol";
import {ViolationBondPool} from "../src/ViolationBondPool.sol";
import {KeelsonRoles} from "../src/access/KeelsonRoles.sol";
import {ForkTest} from "./utils/Fork.sol";
import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice The second contracts release rehearsed on a fork of Arbitrum Sepolia after the first went live: every
/// contract that holds the `VerdictVerifier` or the `KeelsonBondVault` lands at its second-release salt through the
/// deploy scripts, wired to its second-release peers and to the same governance, while the first release keeps its
/// addresses and code.
contract ContractsReleaseForkTest is ForkTest {
    using stdJson for string;

    /// @dev A block after the first release was deployed and wired.
    uint256 internal constant FORK_BLOCK = 328_450_000;
    string internal constant RELEASE = "@2";

    string[9] internal names = [
        "VerdictVerifier",
        "CheckpointAnchor",
        "KeelsonBondVault",
        "KeelsonReserve",
        "KeelsonValidationRegistry",
        "KeelsonReputationReporter",
        "MandateViolationCourt",
        "ViolationBondPool",
        "AmberContradictionCourt"
    ];

    DeployVerdictVerifier internal verifierScript;
    DeployBondVault internal vaultScript;
    DeployReserve internal reserveScript;
    DeployAmberContradictionCourt internal amberScript;
    mapping(string name => bytes32) internal firstCode;

    function setUp() public {
        vm.createSelectFork(vm.envString("ARBITRUM_SEPOLIA_RPC_URL"), FORK_BLOCK);
        for (uint256 i; i < names.length; ++i) {
            address first = _json().readAddress(string.concat(".contracts.", names[i]));
            assertGt(first.code.length, 0, names[i]);
            firstCode[names[i]] = first.codehash;
        }
        vm.setEnv("KEELSON_CONTRACTS_RELEASE", RELEASE);
        verifierScript = new DeployVerdictVerifier();
        vaultScript = new DeployBondVault();
        reserveScript = new DeployReserve();
        amberScript = new DeployAmberContradictionCourt();

        verifierScript.run();
        new DeployCheckpointAnchor().run();
        vaultScript.run("KeelsonBondVault");
        reserveScript.run();
        new DeployErc8004().run();
        new DeployMandateViolationCourt().run();
        new DeployViolationBondPool().run();
        amberScript.run();
        vm.warp(vm.getBlockTimestamp() + _timelock().getMinDelay());
        verifierScript.wire();
        vaultScript.wire("KeelsonBondVault");
        reserveScript.wire();
        amberScript.list();
        vm.setEnv("KEELSON_CONTRACTS_RELEASE", "");
    }

    function _at(string memory name) internal view returns (address) {
        return verifierScript.predict(string.concat(name, RELEASE));
    }

    function _timelock() internal view returns (TimelockController) {
        return TimelockController(payable(_json().readAddress(".contracts.TimelockController")));
    }

    function test_everyContractLandsBesideTheFirstRelease() public view {
        for (uint256 i; i < names.length; ++i) {
            address first = _json().readAddress(string.concat(".contracts.", names[i]));
            string memory saltName = keccak256(bytes(names[i])) == keccak256("AmberContradictionCourt")
                ? "AmberContradictionCourt/3"
                : names[i];
            address second = verifierScript.predict(string.concat(saltName, RELEASE));
            assertGt(second.code.length, 0, names[i]);
            assertTrue(second != first, names[i]);
            assertEq(first.codehash, firstCode[names[i]], "the first release is untouched");
        }
    }

    function test_theSecondReleaseIsWiredToItself() public view {
        VerdictVerifier verifier = VerdictVerifier(_at("VerdictVerifier"));
        KeelsonBondVault vault = KeelsonBondVault(_at("KeelsonBondVault"));
        KeelsonReserve reserve = KeelsonReserve(_at("KeelsonReserve"));
        CheckpointAnchor anchor = CheckpointAnchor(_at("CheckpointAnchor"));
        MandateViolationCourt court = MandateViolationCourt(_at("MandateViolationCourt"));
        ViolationBondPool pool = ViolationBondPool(_at("ViolationBondPool"));
        AmberContradictionCourt amber = AmberContradictionCourt(_at("AmberContradictionCourt/3"));

        assertEq(verifier.BOND_VAULT(), address(vault), "the legs' attestations bind the new vault");
        assertEq(address(anchor.verifier()), address(verifier));
        assertEq(address(vault.verifier()), address(verifier));
        assertEq(address(vault.anchor()), address(anchor));
        assertEq(vault.reserve(), address(reserve));
        assertEq(address(reserve.vault()), address(vault));
        assertEq(address(reserve.verifier()), address(verifier));
        assertEq(address(reserve.anchor()), address(anchor));
        assertEq(address(KeelsonValidationRegistry(_at("KeelsonValidationRegistry")).vault()), address(vault));
        assertEq(address(KeelsonReputationReporter(_at("KeelsonReputationReporter")).vault()), address(vault));
        assertEq(address(court.vault()), address(vault));
        assertEq(address(court.teeVerifier()), address(verifier));
        assertEq(address(amber.vault()), address(vault));
        assertEq(address(amber.teeVerifier()), address(verifier));
        assertEq(address(pool.vault()), address(vault));
        assertTrue(pool.isCourt(address(court)));
        assertTrue(pool.isCourt(address(amber)));
    }

    function test_theSecondReleaseHasTheFirstsGovernance() public {
        AccessManager manager = AccessManager(_json().readAddress(".contracts.AccessManager"));
        address vault = _at("KeelsonBondVault");
        address verifier = _at("VerdictVerifier");
        assertEq(KeelsonBondVault(vault).authority(), address(manager));
        assertEq(manager.getTargetFunctionRole(vault, KeelsonBondVault.vetoSlash.selector), KeelsonRoles.GUARDIAN_ROLE);
        assertEq(
            manager.getTargetFunctionRole(vault, KeelsonBondVault.setParams.selector), KeelsonRoles.PARAMETERS_ROLE
        );
        assertEq(
            manager.getTargetFunctionRole(verifier, VerdictVerifier.setAllowedMeasurement.selector),
            KeelsonRoles.SIGNERS_ROLE
        );
        assertEq(
            manager.getTargetFunctionRole(verifier, VerdictVerifier.revokeSigner.selector), KeelsonRoles.GUARDIAN_ROLE
        );
        // A new target admin delay is in force after the manager's setback.
        vm.warp(vm.getBlockTimestamp() + manager.minSetback());
        assertEq(manager.getTargetAdminDelay(verifier), _json().readUint(".params.signersDelay"));
        assertEq(
            manager.getTargetFunctionRole(_at("KeelsonReserve"), KeelsonReserve.setCooldown.selector),
            KeelsonRoles.PARAMETERS_ROLE
        );
        assertEq(VerdictVerifier(verifier).issuer(), _json().readBytes32(".tee.issuerJwkThumbprint"));
        assertEq(address(KeelsonValidationRegistry(_at("KeelsonValidationRegistry")).verifier()), verifier);
    }
}
