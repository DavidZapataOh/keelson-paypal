// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IKeelsonBondVault} from "./interfaces/IKeelsonBondVault.sol";
import {IVerdictVerifier} from "./interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "./libraries/KeelsonTypes.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice What the court reads from the `KeelsonBondVault`.
interface IAmberVault {
    /// @notice EIP-712 struct hash of each locked `Coverage`; 0 for none.
    function coverageHash(bytes32 coverageId) external view returns (bytes32);

    function coverages(bytes32 coverageId) external view returns (IKeelsonBondVault.CoverageState memory);
}

/// @notice bb's UltraHonk verifier of the C2b `amber_contradiction` circuit.
interface IAmberContradictionVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

/// @title AmberContradictionCourt
/// @notice Records, once per coverage, that an amber field the coverage's operator attested is false: the store's own
/// server said otherwise in a TLS session the TLSNotary notary (leg A) signed as a `WebFact`, and the C2b proof shows
/// that the session's committed JSON object is the attested item (same SKU) with another value of the field. The
/// operator's `amberCommitment` in the locked coverage is what the proof opens. No role, no owner; the
/// `ViolationBondPool` pays the merchant on the conviction.
/// @dev The `WebFact` must have been captured within `FACT_LEAD` before the purchase was countersigned and before the
/// coverage expired, by a TDX signer active at the capture. The countersign gives the purchase time: it is matched to
/// the coverage as `lockCoverage` matched them and must carry signatures of signers active when it was issued.
contract AmberContradictionCourt {
    struct Conviction {
        uint8 fieldId;
        uint40 provenAt;
        bytes32 webFactDigest;
    }

    uint8 public constant SIZE = 1;
    uint8 public constant COLOR = 2;
    uint8 public constant UNIT_PRICE = 3;
    uint8 public constant RETURNS_FREE = 4;
    /// @notice How long before the countersign a `WebFact` may have been captured: the page the agent bought from.
    uint40 public constant FACT_LEAD = 1 hours;

    uint8 internal constant TDX = 1;
    uint8 internal constant NITRO = 2;
    uint8 internal constant ALLOW = 1;
    uint256 internal constant SIGNATURE_LENGTH = 65;
    /// @dev PYUSD base units per US cent, as the vault converts `Countersign.amount`.
    uint256 internal constant PYUSD_PER_MINOR = 10_000;
    uint256 internal constant BN254_FR_MODULUS =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    IAmberVault public immutable vault;
    IVerdictVerifier public immutable teeVerifier;
    IAmberContradictionVerifier public immutable proofVerifier;

    mapping(bytes32 coverageId => Conviction) internal _convictions;

    event AmberContradictionProven(
        bytes32 indexed coverageId, uint256 indexed agentId, uint8 fieldId, bytes32 webFactDigest
    );

    error AlreadyProven();
    error UnknownField();
    /// @notice The coverage is not one the vault locked, or not as given.
    error NotCovered();
    error NoAmberAttestation();
    /// @notice The countersign is not the ALLOW the coverage was locked with.
    error CountersignMismatch();
    error InvalidCountersignature();
    error InvalidWebFact();
    /// @notice The `WebFact` was captured too long before the purchase or after the coverage expired.
    error StaleWebFact();
    error InvalidProof();

    constructor(IAmberVault vault_, IVerdictVerifier teeVerifier_, IAmberContradictionVerifier proofVerifier_) {
        vault = vault_;
        teeVerifier = teeVerifier_;
        proofVerifier = proofVerifier_;
    }

    /// @notice Convicts the operator of coverage `c` of a false amber `fieldId`.
    /// @param cs The countersign `c` was locked with.
    /// @param countersigs `tdx ‖ nitro`, or the TDX signature alone for a coverage locked while Nitro was down.
    /// @param fact The `WebFact` of a TLS session with the store, signed by leg A (`factSig`).
    /// @param proof C2b over `range_hi, range_lo, amber_commitment, product, field_id`: the halves of
    /// `fact.rangeCommitment`, `c.amberCommitment`, `keccak256(abi.encode(fact.hostHash, fact.urlPathHash))` mod the
    /// BN254 scalar field, and `fieldId`.
    function slashAmber(
        KeelsonTypes.Coverage calldata c,
        KeelsonTypes.Countersign calldata cs,
        bytes calldata countersigs,
        KeelsonTypes.WebFact calldata fact,
        bytes calldata factSig,
        uint8 fieldId,
        bytes calldata proof
    ) external {
        if (fieldId == 0 || fieldId > RETURNS_FREE) revert UnknownField();
        if (_convictions[c.coverageId].fieldId != 0) revert AlreadyProven();
        bytes32 locked = vault.coverageHash(c.coverageId);
        if (locked == 0 || locked != KeelsonTypes.hash(c)) revert NotCovered();
        if (c.amberCommitment == 0) revert NoAmberAttestation();
        if (
            cs.requestId != c.coverageId || cs.agentId != c.agentId || cs.mandateHash != c.mandateHash
                || cs.decision != ALLOW || uint256(cs.amount) * PYUSD_PER_MINOR != c.amount
        ) revert CountersignMismatch();
        // One TDX signature counts only for a coverage the vault locked on one.
        if (countersigs.length != 2 * SIGNATURE_LENGTH && !vault.coverages(c.coverageId).degraded) {
            revert InvalidCountersignature();
        }
        if (!_countersigned(teeVerifier.hashTypedData(KeelsonTypes.hash(cs)), countersigs, cs.issuedAt)) {
            revert InvalidCountersignature();
        }
        if (uint256(fact.tCapture) + FACT_LEAD < cs.issuedAt || fact.tCapture > c.expiresAt) revert StaleWebFact();
        bytes32 factDigest = teeVerifier.hashTypedData(KeelsonTypes.hash(fact));
        if (factSig.length != SIGNATURE_LENGTH || !_signedAt(factDigest, factSig, TDX, fact.tCapture)) {
            revert InvalidWebFact();
        }

        bytes32[] memory inputs = new bytes32[](5);
        inputs[0] = fact.rangeCommitment >> 128;
        inputs[1] = bytes32(uint256(uint128(uint256(fact.rangeCommitment))));
        inputs[2] = c.amberCommitment;
        inputs[3] = bytes32(uint256(keccak256(abi.encode(fact.hostHash, fact.urlPathHash))) % BN254_FR_MODULUS);
        inputs[4] = bytes32(uint256(fieldId));
        // bb's verifiers revert on most failed checks and return false on the last one.
        try proofVerifier.verify(proof, inputs) returns (bool ok) {
            if (!ok) revert InvalidProof();
        } catch {
            revert InvalidProof();
        }

        _convictions[c.coverageId] =
            Conviction({fieldId: fieldId, provenAt: SafeCast.toUint40(block.timestamp), webFactDigest: factDigest});
        emit AmberContradictionProven(c.coverageId, c.agentId, fieldId, factDigest);
    }

    /// @notice The conviction of a coverage, as `IConvictions` reads it: `code` is the false field, 0 for none.
    function violations(bytes32 coverageId)
        external
        view
        returns (uint8 code, uint40 provenAt, bytes32 evidenceDigest)
    {
        Conviction memory v = _convictions[coverageId];
        return (v.fieldId, v.provenAt, v.webFactDigest);
    }

    function _countersigned(bytes32 digest, bytes calldata sigs, uint40 issuedAt) internal view returns (bool) {
        if (sigs.length == 2 * SIGNATURE_LENGTH) {
            return _signedAt(digest, sigs[:SIGNATURE_LENGTH], TDX, issuedAt)
                && _signedAt(digest, sigs[SIGNATURE_LENGTH:], NITRO, issuedAt);
        }
        return sigs.length == SIGNATURE_LENGTH && _signedAt(digest, sigs, TDX, issuedAt);
    }

    /// @dev Whether a `teeKind` signer registered by `time`, still in that registration and never revoked, under a
    /// measurement still allowed, signed `digest`. Malformed and high-S signatures recover the zero address, which is
    /// never registered.
    function _signedAt(bytes32 digest, bytes calldata sig, uint8 teeKind, uint40 time) internal view returns (bool) {
        (address signer,,) = ECDSA.tryRecover(digest, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
        (uint8 kind, uint40 registeredAt, uint40 expiresAt, uint40 revokedAt, bytes32 measurement) =
            teeVerifier.signers(signer);
        return kind == teeKind && revokedAt == 0 && registeredAt != 0 && registeredAt <= time && time < expiresAt
            && teeVerifier.allowedMeasurement(measurement);
    }
}
