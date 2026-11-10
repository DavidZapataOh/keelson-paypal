// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IVerdictVerifier} from "./interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "./libraries/KeelsonTypes.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice What the court reads from the `KeelsonBondVault`.
interface ICoveredVault {
    /// @notice EIP-712 struct hash of each locked `Coverage`; 0 for none.
    function coverageHash(bytes32 coverageId) external view returns (bytes32);
}

/// @notice bb's UltraHonk verifier of the C2a `mandate_violation` circuit.
interface IMandateViolationVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

/// @title MandateViolationCourt
/// @notice Records, once per coverage, that the purchase a `KeelsonBondVault` coverage backs violated the user's
/// mandate: anyone holding the mandate's opening proves it with the C2a circuit against the countersign the coverage
/// was locked with. No role, no owner, nothing to configure; the proof, the TEE signatures and the vault's state are
/// the whole trust. A conviction makes the operator liable under the attribution rule for a missing valid proof, so the
/// slash itself is the vault's.
/// @dev The countersign is matched to the coverage as `lockCoverage` matched them, and its signers must have been
/// registered, unrevoked and under an allowed measurement when it was issued, so a dispute can come long after the
/// signers' registrations lapsed.
contract MandateViolationCourt {
    /// @notice A conviction: which rule the cart broke and the countersign it was proven against.
    struct Violation {
        uint8 code;
        uint40 provenAt;
        bytes32 countersignDigest;
    }

    uint8 public constant AMOUNT_OVER_MAX = 1;
    uint8 public constant CURRENCY_MISMATCH = 2;
    uint8 public constant CATEGORY_NOT_ALLOWED = 3;
    uint8 public constant MANDATE_EXPIRED = 4;
    uint8 public constant MERCHANT_NOT_ALLOWED = 5;

    uint8 internal constant TDX = 1;
    uint8 internal constant NITRO = 2;
    uint8 internal constant ALLOW = 1;
    uint256 internal constant SIGNATURE_LENGTH = 65;
    /// @dev PYUSD base units per US cent, as the vault converts `Countersign.amount`.
    uint256 internal constant PYUSD_PER_MINOR = 10_000;

    ICoveredVault public immutable vault;
    IVerdictVerifier public immutable teeVerifier;
    IMandateViolationVerifier public immutable proofVerifier;

    /// @notice The conviction of each coverage; `code == 0` while there is none.
    mapping(bytes32 coverageId => Violation) public violations;

    event MandateViolationProven(
        bytes32 indexed coverageId, uint256 indexed agentId, uint8 violationCode, bytes32 countersignDigest
    );

    error AlreadyProven();
    error UnknownViolation();
    /// @notice The coverage is not one the vault locked, or not as given.
    error NotCovered();
    /// @notice The countersign is not the ALLOW the coverage was locked with.
    error CountersignMismatch();
    error InvalidCountersignature();
    error InvalidProof();

    constructor(ICoveredVault vault_, IVerdictVerifier teeVerifier_, IMandateViolationVerifier proofVerifier_) {
        vault = vault_;
        teeVerifier = teeVerifier_;
        proofVerifier = proofVerifier_;
    }

    /// @notice Convicts the coverage `c` of the violation `violationCode` of its mandate.
    /// @param cs The countersign `c` was locked with.
    /// @param countersigs `tdx ‖ nitro`, or the TDX signature alone for a coverage locked while Nitro was down.
    /// @param proof C2a over `C_m, amount, currency, category, merchant_id, cart_ts, violation_code`, read from `cs`
    /// with `cart_ts` its `issuedAt`.
    function proveViolation(
        KeelsonTypes.Coverage calldata c,
        KeelsonTypes.Countersign calldata cs,
        bytes calldata countersigs,
        uint8 violationCode,
        bytes calldata proof
    ) external {
        if (violationCode == 0 || violationCode > MERCHANT_NOT_ALLOWED) revert UnknownViolation();
        if (violations[c.coverageId].code != 0) revert AlreadyProven();
        bytes32 locked = vault.coverageHash(c.coverageId);
        if (locked == 0 || locked != KeelsonTypes.hash(c)) revert NotCovered();
        if (
            cs.requestId != c.coverageId || cs.agentId != c.agentId || cs.mandateHash != c.mandateHash
                || cs.decision != ALLOW || uint256(cs.amount) * PYUSD_PER_MINOR != c.amount
        ) revert CountersignMismatch();

        bytes32 digest = teeVerifier.hashTypedData(KeelsonTypes.hash(cs));
        if (!_countersigned(digest, countersigs, cs.issuedAt)) revert InvalidCountersignature();

        bytes32[] memory inputs = new bytes32[](7);
        inputs[0] = cs.mandateCommitment;
        inputs[1] = bytes32(uint256(cs.amount));
        inputs[2] = bytes32(uint256(cs.currency));
        inputs[3] = bytes32(uint256(cs.category));
        inputs[4] = cs.merchantId;
        inputs[5] = bytes32(uint256(cs.issuedAt));
        inputs[6] = bytes32(uint256(violationCode));
        // bb's verifiers revert on most failed checks and return false on the last one.
        try proofVerifier.verify(proof, inputs) returns (bool ok) {
            if (!ok) revert InvalidProof();
        } catch {
            revert InvalidProof();
        }

        violations[c.coverageId] =
            Violation({code: violationCode, provenAt: SafeCast.toUint40(block.timestamp), countersignDigest: digest});
        emit MandateViolationProven(c.coverageId, c.agentId, violationCode, digest);
    }

    function _countersigned(bytes32 digest, bytes calldata sigs, uint40 issuedAt) internal view returns (bool) {
        if (sigs.length == 2 * SIGNATURE_LENGTH) {
            return _signedAt(digest, sigs[:SIGNATURE_LENGTH], TDX, issuedAt)
                && _signedAt(digest, sigs[SIGNATURE_LENGTH:], NITRO, issuedAt);
        }
        return sigs.length == SIGNATURE_LENGTH && _signedAt(digest, sigs, TDX, issuedAt);
    }

    /// @dev Whether a `teeKind` signer registered by `issuedAt`, still in that registration and never revoked, under a
    /// measurement still allowed, signed `digest`. Malformed and high-S signatures recover nobody.
    function _signedAt(bytes32 digest, bytes calldata sig, uint8 teeKind, uint40 issuedAt)
        internal
        view
        returns (bool)
    {
        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(digest, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
        if (err != ECDSA.RecoverError.NoError) return false;
        (uint8 kind, uint40 registeredAt, uint40 expiresAt, uint40 revokedAt, bytes32 measurement) =
            teeVerifier.signers(signer);
        return kind == teeKind && revokedAt == 0 && registeredAt != 0 && registeredAt <= issuedAt
            && issuedAt < expiresAt && teeVerifier.allowedMeasurement(measurement);
    }
}
