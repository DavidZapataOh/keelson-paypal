// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {INitroValidator} from "../interfaces/INitroValidator.sol";
import {CborElement} from "@nitro-validator/CborDecode.sol";

/// @title NitroDocument
/// @notice Reads what Keelson needs out of an AWS Nitro attestation document validated by Base's `NitroValidator`.
/// @dev A `CborElement` packs `type | start << 80 | value << 160`; for byte strings `value` is the length.
library NitroDocument {
    struct Fields {
        /// @dev `sha256(PCR0 ‖ PCR1 ‖ PCR2)`: the enclave image, kernel and application.
        bytes32 measurement;
        bytes userData;
        bytes nonce;
        /// @dev The address of the document's `public_key`, a SEC1 uncompressed secp256k1 key.
        address key;
        uint64 timestampMs;
    }

    uint256 private constant BYTE_STRING = 0x40;

    /// @notice PCR0, PCR1 or PCR2 is missing or not 48 bytes, or PCR0 is zero (debug mode).
    error NitroPcrsMissing();
    /// @notice `public_key` is not a 65-byte SEC1 uncompressed key.
    error NitroKeyMismatch();

    /// @param tbs The COSE_Sign1 to-be-signed bytes the validator checked.
    /// @param p The pointers the validator returned for `tbs`.
    function read(bytes memory tbs, INitroValidator.Ptrs memory p) internal pure returns (Fields memory f) {
        if (_length(p.pcrs[0]) != 48 || _length(p.pcrs[1]) != 48 || _length(p.pcrs[2]) != 48) {
            revert NitroPcrsMissing();
        }
        // A debug-mode enclave reports all-zero PCRs.
        if (keccak256(_slice(tbs, p.pcrs[0])) == keccak256(new bytes(48))) revert NitroPcrsMissing();
        f.measurement = sha256(bytes.concat(_slice(tbs, p.pcrs[0]), _slice(tbs, p.pcrs[1]), _slice(tbs, p.pcrs[2])));
        f.userData = _slice(tbs, p.userData);
        f.nonce = _slice(tbs, p.nonce);
        bytes memory key = _slice(tbs, p.publicKey);
        if (key.length != 65 || key[0] != 0x04) revert NitroKeyMismatch();
        bytes32 hash;
        assembly ("memory-safe") {
            hash := keccak256(add(key, 0x21), 64)
        }
        f.key = address(uint160(uint256(hash)));
        f.timestampMs = p.timestamp;
    }

    /// @dev The length of a byte string; zero for null, absent or any other type.
    function _length(CborElement e) private pure returns (uint256) {
        uint256 raw = CborElement.unwrap(e);
        return raw & 0xff == BYTE_STRING ? (raw >> 160) & type(uint64).max : 0;
    }

    /// @dev The content of a byte string; empty for null, absent or any other type.
    function _slice(bytes memory tbs, CborElement e) private pure returns (bytes memory out) {
        uint256 length = _length(e);
        uint256 start = (CborElement.unwrap(e) >> 80) & type(uint80).max;
        out = new bytes(length);
        if (length != 0) {
            assembly ("memory-safe") {
                mcopy(add(out, 0x20), add(add(tbs, 0x20), start), length)
            }
        }
    }
}
