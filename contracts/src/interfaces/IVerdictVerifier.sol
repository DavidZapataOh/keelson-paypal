// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonTypes} from "../libraries/KeelsonTypes.sol";

/// @title IVerdictVerifier
/// @notice Registry of the TEE signers that countersign, judge and checkpoint for Keelson, and verification of their
/// signatures.
interface IVerdictVerifier {
    /// @notice What a signer's attestation binds it to. Its hash is the first half of the attestation's `report_data`.
    struct SignerBinding {
        uint8 teeKind;
        address signer;
        bytes32 policySetHash;
        bytes32 engineBuildId;
        uint64 bootEpoch;
        bytes32 issuerJwkThumbprint;
    }

    /// @notice Emitted on every registration; a re-registration keeps `registeredAt` and moves `expiresAt`.
    event SignerRegistered(
        address indexed signer, uint8 teeKind, bytes32 measurement, uint40 registeredAt, uint40 expiresAt
    );
    event SignerRevoked(address indexed signer, uint40 revokedAt);
    event SignerEquivocated(address indexed signer, bytes32 digestA, bytes32 digestB);
    event MeasurementAllowed(bytes32 indexed measurement, bool allowed);
    event IssuerSet(bytes32 issuer);

    error MeasurementNotAllowed(bytes32 measurement);
    error BindingMismatch();
    error IssuerMismatch();
    error StaleBlock();
    error UnknownBlock();
    error TcbStatusNotAccepted(uint8 status);
    error AttestationFailed(string reason);
    error QuoteNotTdx();
    error TdDebug();
    /// @notice The TD was launched with attributes other than SEPT_VE_DISABLE alone, another XFAM, an owner, or an
    /// MRCONFIGID dstack does not set.
    error TdPolicy();
    error Rtmr3Mismatch();
    error NitroDocumentStale();
    error NitroKeyMismatch();
    error NitroNonceMismatch();
    error NitroPcrsMissing();
    error SignerIsRevoked();
    error SignerConflict();
    error NotEquivocation();
    error WrongTeeKind();
    error ZeroAddress();

    function signers(address signer)
        external
        view
        returns (uint8 teeKind, uint40 registeredAt, uint40 expiresAt, uint40 revokedAt, bytes32 measurement);

    /// @notice Registered as `teeKind`, not revoked, not expired, and its measurement still allowed.
    function isActive(address signer, uint8 teeKind) external view returns (bool);

    /// @notice True iff `sigs` is a TDX signature then a Nitro signature over `digest` (65 bytes each, `r ‖ s ‖ v`),
    /// each from an active signer of its kind.
    function verify2of2(bytes32 digest, bytes calldata sigs) external view returns (bool);

    /// @notice True iff `sig` (65 bytes, `r ‖ s ‖ v`) is over `digest` from an active TDX signer. Only for messages
    /// signed while the Nitro leg is down, which the caller must treat as degraded.
    function verifyDegraded(bytes32 digest, bytes calldata sig) external view returns (bool);

    /// @notice The EIP-712 digest of a TEE-signed message: `keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)`.
    function hashTypedData(bytes32 structHash) external view returns (bytes32);

    function allowedMeasurement(bytes32 measurement) external view returns (bool);

    function issuer() external view returns (bytes32);

    // forge-lint: disable-next-line(mixed-case-function)
    function BOND_VAULT() external view returns (address);

    function setAllowedMeasurement(bytes32 measurement, bool allowed) external;

    function setIssuer(bytes32 issuer) external;

    /// @notice Deactivates every signer with `measurement` at once and stops new registrations from it. Allowing a
    /// measurement again reactivates its unexpired signers.
    function disallowMeasurement(bytes32 measurement) external;

    function revokeSigner(address signer) external;

    /// @notice Revokes the signer of two different `Countersign`s with the same `requestId`: an engine answers a
    /// request id once, so two of them prove its key is compromised.
    function reportEquivocation(
        KeelsonTypes.Countersign calldata a,
        KeelsonTypes.Countersign calldata b,
        bytes calldata sigA,
        bytes calldata sigB
    ) external;
}
