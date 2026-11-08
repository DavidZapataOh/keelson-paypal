// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IVerdictVerifier} from "../../src/interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "../../src/libraries/KeelsonTypes.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Two secp256k1 keys installed as one TDX and one Nitro signer of a forked `VerdictVerifier`, under the
/// measurements the live legs run, to sign `Verdict`s until the legs sign them. Registration needs a real quote, which
/// can only bind a key born inside a TEE, so the records are written at the slots `forge inspect VerdictVerifier
/// storageLayout` reports. They exist only on the fork.
abstract contract VerdictSigners is Test {
    using stdJson for string;

    uint256 internal constant MEASUREMENT_IDS_SLOT = 4;
    uint256 internal constant SIGNERS_SLOT = 7;

    IVerdictVerifier internal verdictVerifier;
    uint256 internal tdxKey;
    uint256 internal nitroKey;

    function _installVerdictSigners(IVerdictVerifier verifier_) internal {
        verdictVerifier = verifier_;
        string memory m = vm.readFile(string.concat(vm.projectRoot(), "/../engine/tee/measurements.json"));
        address tdx;
        address nitro;
        (tdx, tdxKey) = makeAddrAndKey("fork-only tdx verdict signer");
        (nitro, nitroKey) = makeAddrAndKey("fork-only nitro verdict signer");
        _store(tdx, 1, _measurement(m.readString(".tdx.id")));
        _store(nitro, 2, _measurement(m.readString(".nitro.id")));
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

    /// @dev `tdx:<hex>` or `nitro:<hex>` → the measurement.
    function _measurement(string memory id) private pure returns (bytes32) {
        string[] memory parts = vm.split(id, ":");
        return vm.parseBytes32(string.concat("0x", parts[1]));
    }
}
