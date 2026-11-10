// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {AmberContradictionCourt, IAmberContradictionVerifier, IAmberVault} from "../src/AmberContradictionCourt.sol";
import {ViolationBondPool} from "../src/ViolationBondPool.sol";
import {IVerdictVerifier} from "../src/interfaces/IVerdictVerifier.sol";
import {HonkVerifierDeploy} from "./HonkVerifierDeploy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys the C2b `amber_contradiction` verifiers and the `AmberContradictionCourt` that uses the optimized one,
/// over the registry's `KeelsonBondVault` and `VerdictVerifier`, and lists the court in the `ViolationBondPool` through
/// the timelock (the pool's admin).
/// @dev `run()` deploys and schedules the listing; `list()` executes it once the timelock delay has passed. Both are
/// idempotent.
contract DeployAmberContradictionCourt is HonkVerifierDeploy {
    using stdJson for string;

    string internal constant PREFIX = "AmberContradiction";
    string internal constant COURT = "AmberContradictionCourt";

    function run() external returns (AmberContradictionCourt court) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        (address verifier,) = _deployVerifiers(PREFIX);
        court = AmberContradictionCourt(_deploy(COURT, type(AmberContradictionCourt).creationCode, courtArgs(verifier)));
        if (!_pool().isCourt(address(court))) {
            (address target, bytes memory payload) = listing(address(court));
            TimelockController timelock = _timelock();
            bytes32 id = timelock.hashOperation(target, 0, payload, bytes32(0), _listingSalt());
            if (!timelock.isOperation(id)) {
                timelock.schedule(target, 0, payload, bytes32(0), _listingSalt(), timelock.getMinDelay());
            }
        }
        vm.stopBroadcast();
    }

    function list() external {
        address court = predict(COURT);
        if (_pool().isCourt(court)) return;
        (address target, bytes memory payload) = listing(court);
        vm.broadcast(_owner());
        _timelock().execute(target, 0, payload, bytes32(0), _listingSalt());
    }

    function courtArgs(address verifier) public view returns (bytes memory) {
        string memory json = _registry();
        return abi.encode(
            IAmberVault(json.readAddress(".contracts.KeelsonBondVault")),
            IVerdictVerifier(json.readAddress(".contracts.VerdictVerifier")),
            IAmberContradictionVerifier(verifier)
        );
    }

    function listing(address court) public view returns (address target, bytes memory payload) {
        return (address(_pool()), abi.encodeCall(ViolationBondPool.setCourt, (court, true)));
    }

    /// @notice The reference verifier's creation code, linked to the libraries at their CREATE3 addresses.
    function referenceCode() public view returns (bytes memory) {
        return _referenceCode(PREFIX);
    }

    function _pool() internal view returns (ViolationBondPool) {
        return ViolationBondPool(_registry().readAddress(".contracts.ViolationBondPool"));
    }

    function _timelock() internal view returns (TimelockController) {
        return TimelockController(payable(_registry().readAddress(".contracts.TimelockController")));
    }

    function _listingSalt() internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(RELEASE, "/", COURT, "/listing"));
    }
}
