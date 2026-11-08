// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CborElement} from "@nitro-validator/CborDecode.sol";

/// @title INitroValidator
/// @notice The hinted entrypoint of Base's `NitroValidator` (base/nitro-validator `0ea0d12`), whose `Ptrs` locate the
/// fields of the validated attestation document inside its to-be-signed bytes.
interface INitroValidator {
    struct Ptrs {
        CborElement moduleID;
        uint64 timestamp;
        CborElement digest;
        /// @dev Always 32 slots, indexed by PCR number; missing PCRs are CBOR null.
        CborElement[] pcrs;
        CborElement cert;
        CborElement[] cabundle;
        CborElement publicKey;
        CborElement userData;
        CborElement nonce;
    }

    /// @dev The document's whole certificate chain must already be cached in the validator's `CertManager`.
    function validateAttestationWithHints(
        bytes memory attestationTbs,
        bytes memory signature,
        bytes memory attestationSigHints
    ) external returns (Ptrs memory);
}
