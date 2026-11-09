// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IVerdictVerifier} from "../../src/interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Two secp256k1 keys installed as one TDX and one Nitro signer of a forked `VerdictVerifier`, under the
/// measurements the live legs run, to sign `Verdict`s until the legs sign them. Registration needs a real quote, which
/// can only bind a key born inside a TEE, so the records are written at the slots `forge inspect VerdictVerifier
/// storageLayout` reports. They exist only on the fork.
abstract contract VerdictSigners is Test {
    uint256 internal constant MEASUREMENT_IDS_SLOT = 4;
    uint256 internal constant SIGNERS_SLOT = 7;

    IVerdictVerifier internal verdictVerifier;
    uint256 internal tdxKey;
    uint256 internal nitroKey;

    /// @dev Measurements the VerdictVerifier allows at `VaultBase.FORK_BLOCK`, not the live legs' current ones.
    bytes32 internal constant FORK_TDX_MEASUREMENT = 0x0f02189b65737875b58db9e50801fe710433cc7580481670b4a08b9020dd62ae;
    bytes32 internal constant FORK_NITRO_MEASUREMENT =
        0xc3077e2be4b9b20d3abdc05d577f4ccba942b32580b08a1bff1a2b23baf8baf7;

    /// @dev The fork measurements, for a verifier deployed on the fork.
    function _forkMeasurements() internal pure returns (bytes32[] memory measurements) {
        measurements = new bytes32[](2);
        measurements[0] = FORK_TDX_MEASUREMENT;
        measurements[1] = FORK_NITRO_MEASUREMENT;
    }

    function _installVerdictSigners(IVerdictVerifier verifier_) internal {
        verdictVerifier = verifier_;
        address tdx;
        address nitro;
        (tdx, tdxKey) = makeAddrAndKey("fork-only tdx verdict signer");
        (nitro, nitroKey) = makeAddrAndKey("fork-only nitro verdict signer");
        _store(tdx, 1, FORK_TDX_MEASUREMENT);
        _store(nitro, 2, FORK_NITRO_MEASUREMENT);
        assertTrue(verifier_.isActive(tdx, 1) && verifier_.isActive(nitro, 2), "verdict signers");
    }

    /// @dev `tdx ‖ nitro`, as the legs sign.
    function _sign2of2(KeelsonTypes.Verdict memory v) internal view returns (bytes memory) {
        return bytes.concat(_signWith(tdxKey, v), _signWith(nitroKey, v));
    }

    /// @dev The TDX leg alone, while the Nitro leg is down.
    function _signDegraded(KeelsonTypes.Verdict memory v) internal view returns (bytes memory) {
        return _signWith(tdxKey, v);
    }

    function _signWith(uint256 pk, KeelsonTypes.Verdict memory v) internal view returns (bytes memory) {
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(pk, verdictVerifier.hashTypedData(KeelsonTypes.hash(v)));
        return abi.encodePacked(r, s, sv);
    }

    function _store(address signer, uint8 teeKind, bytes32 measurement) private {
        uint256 id =
            uint256(vm.load(address(verdictVerifier), keccak256(abi.encode(measurement, MEASUREMENT_IDS_SLOT))));
        assertGt(id, 0, "measurement registered");
        bytes32 slot = keccak256(abi.encode(signer, SIGNERS_SLOT));
        uint256 now_ = vm.getBlockTimestamp();
        uint256 packed = uint256(teeKind) | now_ << 8 | uint256(type(uint40).max) << 48 | id << 128;
        vm.store(address(verdictVerifier), slot, bytes32(packed));
        vm.store(address(verdictVerifier), bytes32(uint256(slot) + 1), measurement);
    }
}
