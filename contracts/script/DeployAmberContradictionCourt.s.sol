// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {AmberContradictionCourt, IAmberContradictionVerifier, IAmberVault} from "../src/AmberContradictionCourt.sol";
import {ViolationBondPool} from "../src/ViolationBondPool.sol";
import {IVerdictVerifier} from "../src/interfaces/IVerdictVerifier.sol";
import {HonkVerifierDeploy} from "./HonkVerifierDeploy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice Deploys the C2b `amber_contradiction` verifiers and the `AmberContradictionCourt` that uses the optimized one,
/// over the registry's `KeelsonBondVault` and `VerdictVerifier`, and, through the timelock (the pool's admin), lists it
/// in the `ViolationBondPool` and delists the court it replaces.
/// @dev `run()` deploys and schedules the batch; `list()` executes it once the timelock delay has passed. Both are
/// idempotent. The court is recorded as `AmberContradictionCourt` at the CREATE3 address of `VERSION`; the earlier
/// court keeps the address of `PREVIOUS`, and the pool keeps paying the convictions it recorded before its delisting.
contract DeployAmberContradictionCourt is HonkVerifierDeploy {
    using stdJson for string;

    string internal constant PREFIX = "AmberContradiction";
    string internal constant COURT = "AmberContradictionCourt";
    /// @notice The court that binds the `WebFact` to the purchase's countersigned evidence.
    string internal constant VERSION = "AmberContradictionCourt/2";
    string internal constant PREVIOUS = "AmberContradictionCourt";

    function run() external returns (AmberContradictionCourt court) {
        vm.startBroadcast(_owner());
        _ensureDeployer();
        // The verifiers are recorded once: their libraries' registry names nest under the reference verifier's.
        address verifier = predict(_verifier(PREFIX));
        if (verifier.code.length == 0) (verifier,) = _deployVerifiers(PREFIX);
        court = AmberContradictionCourt(
            _deployVersion(COURT, VERSION, type(AmberContradictionCourt).creationCode, courtArgs(verifier))
        );
        if (!_pool().isCourt(address(court))) {
            (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = listing(address(court));
            TimelockController timelock = _timelock();
            bytes32 id = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), _listingSalt());
            if (!timelock.isOperation(id)) {
                timelock.scheduleBatch(targets, values, payloads, bytes32(0), _listingSalt(), timelock.getMinDelay());
            }
        }
        vm.stopBroadcast();
    }

    function list() external {
        address court = predict(VERSION);
        if (_pool().isCourt(court)) return;
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = listing(court);
        vm.broadcast(_owner());
        _timelock().executeBatch(targets, values, payloads, bytes32(0), _listingSalt());
    }

    function courtArgs(address verifier) public view returns (bytes memory) {
        string memory json = _registry();
        return abi.encode(
            IAmberVault(json.readAddress(".contracts.KeelsonBondVault")),
            IVerdictVerifier(json.readAddress(".contracts.VerdictVerifier")),
            IAmberContradictionVerifier(verifier)
        );
    }

    /// @notice The pool's `setCourt` calls: list `court`, and delist the previous court.
    function listing(address court)
        public
        view
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        targets = new address[](2);
        values = new uint256[](2);
        payloads = new bytes[](2);
        (targets[0], targets[1]) = (address(_pool()), address(_pool()));
        payloads[0] = abi.encodeCall(ViolationBondPool.setCourt, (court, true));
        payloads[1] = abi.encodeCall(ViolationBondPool.setCourt, (predict(PREVIOUS), false));
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
        return keccak256(abi.encodePacked(RELEASE, "/", VERSION, "/listing"));
    }
}
