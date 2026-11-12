// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {EngineProofVerifier} from "./EngineProofVerifier.sol";
import {IKeelsonBondVault} from "./interfaces/IKeelsonBondVault.sol";
import {IVerdictVerifier} from "./interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "./libraries/KeelsonTypes.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title EngineProofCourt
/// @notice Vetoes a queued slash whose verdict blames the operator for a mandate field the purchase's countersigned
/// evaluation failed, when an SP1 proof recorded in the `EngineProofVerifier` shows that evaluation is the honest
/// engine's: the same canonicalizer and Cedar policies, run in the zkVM over the countersign's stored inputs, give the
/// ALLOW both TEE legs signed, and an ALLOW passes every field. The TEE legs alone cannot slash a bond for an
/// evaluation the proven engine did not make. Permissionless; holds `GUARDIAN_ROLE` on the vault, and calls only
/// `vetoSlash`.
/// @dev A field an independent observation of the item can contradict (the amount and the variant, which Channel3
/// observes) can fail without the evaluation failing it, so a verdict naming one is never contested. The countersign
/// is bound to the coverage by its request id and its signatures: each leg answers a request id once, and two
/// countersigns under one id are an equivocation the `VerdictVerifier` revokes the signers for.
contract EngineProofCourt {
    /// @dev `failedFieldsMask` bits of `keelson_policy::FIELD_BITS` an independent observation also fails.
    uint8 public constant AMOUNT_FIELD = 3;
    uint8 public constant VARIANT_FIELD = 9;
    /// @dev The attribution rules that blame a failed mandate field: R60 (green), R61 (amber) and R62 (gray).
    uint8 internal constant FIRST_FIELD_RULE = 60;
    uint8 internal constant LAST_FIELD_RULE = 62;

    uint8 internal constant TDX = 1;
    uint8 internal constant NITRO = 2;
    uint8 internal constant ALLOW = 1;
    uint256 internal constant SIGNATURE_LENGTH = 65;

    IKeelsonBondVault public immutable vault;
    IVerdictVerifier public immutable teeVerifier;
    EngineProofVerifier public immutable engineProofs;

    event SlashContested(bytes32 indexed disputeId, bytes32 indexed countersignDigest, uint8 fieldId);

    /// @notice The verdict is not the one the slash was queued with.
    error VerdictMismatch();
    /// @notice The slash is not queued, or belongs to a batch, whose coverages carry no countersign.
    error NotContestable();
    /// @notice The verdict's rule does not rest on the evaluation failing a field.
    error NotAnEvaluationFault();
    /// @notice The countersign is not the ALLOW of the verdict's coverage.
    error CountersignMismatch();
    error InvalidCountersignature();
    /// @notice No engine proof of the countersign is recorded.
    error NotProven();

    constructor(IKeelsonBondVault vault_, IVerdictVerifier teeVerifier_, EngineProofVerifier engineProofs_) {
        vault = vault_;
        teeVerifier = teeVerifier_;
        engineProofs = engineProofs_;
    }

    /// @notice Vetoes the queued slash of verdict `v`, inside its veto window.
    /// @param cs The ALLOW the verdict's coverage was locked with.
    /// @param countersigs `tdx ‖ nitro`, or the TDX leg's alone for a degraded coverage, as the vault accepted them.
    function contest(KeelsonTypes.Verdict calldata v, KeelsonTypes.Countersign calldata cs, bytes calldata countersigs)
        external
    {
        IKeelsonBondVault.QueuedSlash memory q = vault.queuedSlashes(v.disputeId);
        if (q.status != IKeelsonBondVault.SlashStatus.Queued || q.batchId != 0) revert NotContestable();
        if (q.verdictDigest != teeVerifier.hashTypedData(KeelsonTypes.hash(v))) revert VerdictMismatch();
        if (
            v.ruleId < FIRST_FIELD_RULE || v.ruleId > LAST_FIELD_RULE || v.fieldId == AMOUNT_FIELD
                || v.fieldId == VARIANT_FIELD
        ) revert NotAnEvaluationFault();
        if (cs.requestId != v.coverageId || cs.agentId != v.agentId || cs.decision != ALLOW) {
            revert CountersignMismatch();
        }
        bytes32 digest = teeVerifier.hashTypedData(KeelsonTypes.hash(cs));
        if (!_countersigned(digest, countersigs, cs.issuedAt, vault.coverages(v.coverageId).degraded)) {
            revert InvalidCountersignature();
        }
        if (cs.evalHash == 0 || engineProofs.proven(digest) != cs.evalHash) revert NotProven();
        emit SlashContested(v.disputeId, digest, v.fieldId);
        vault.vetoSlash(v.disputeId, "engine proof");
    }

    function _countersigned(bytes32 digest, bytes calldata sigs, uint40 time, bool degraded)
        internal
        view
        returns (bool)
    {
        if (sigs.length == SIGNATURE_LENGTH) return degraded && _signedAt(digest, sigs, TDX, time);
        return sigs.length == 2 * SIGNATURE_LENGTH && _signedAt(digest, sigs[:SIGNATURE_LENGTH], TDX, time)
            && _signedAt(digest, sigs[SIGNATURE_LENGTH:], NITRO, time);
    }

    /// @dev Whether a signer of `teeKind`, registered and unrevoked at `time` under a measurement still allowed, signed.
    function _signedAt(bytes32 digest, bytes calldata sig, uint8 teeKind, uint40 time) internal view returns (bool) {
        // slither-disable-next-line unused-return
        (address signer,,) = ECDSA.tryRecover(digest, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
        (uint8 kind, uint40 registeredAt, uint40 expiresAt, uint40 revokedAt, bytes32 measurement) =
            teeVerifier.signers(signer);
        return kind == teeKind && revokedAt == 0 && registeredAt != 0 && registeredAt <= time && time < expiresAt
            && teeVerifier.allowedMeasurement(measurement);
    }
}
