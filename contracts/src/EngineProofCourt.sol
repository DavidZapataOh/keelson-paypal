// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {EngineProofVerifier} from "./EngineProofVerifier.sol";
import {IKeelsonBondVault} from "./interfaces/IKeelsonBondVault.sol";
import {IKeelsonValidationRegistry} from "./interfaces/IKeelsonValidationRegistry.sol";
import {IVerdictVerifier} from "./interfaces/IVerdictVerifier.sol";
import {KeelsonTypes} from "./libraries/KeelsonTypes.sol";

/// @title EngineProofCourt
/// @notice Vetoes a queued slash whose verdict blames the operator for a mandate field the purchase's evaluation failed,
/// when the `EngineProofVerifier` holds the SP1 proof of the coverage's countersign: the engine's canonicalizer and
/// Cedar policies, run in the zkVM over the logged inputs, give exactly the ALLOW both TEE legs signed, and an ALLOW
/// passes every field. The TEE legs alone cannot slash a bond for an evaluation the proven engine did not make.
/// Permissionless; holds only `VETO_ROLE`, and calls only `vetoSlash`.
/// @dev The proof is complete evidence only against R60, R61 and R62, the rules that blame a failed field, and only for a
/// field the evaluation alone decides: the amount and the variant also fail on an independent observation (Channel3),
/// which the proof does not cover. Every other rule rests on facts outside the evaluation (the log inclusion, the
/// attestation, the capture, the delivery) and is never contested; warranties are paid by the reserve, which this court
/// cannot touch. The coverage's countersign is the one `KeelsonValidationRegistry` recorded for it: an ALLOW whose
/// signatures the vault accepted at the lock.
contract EngineProofCourt {
    /// @dev `failedFieldsMask` bits (`keelson_policy::FIELD_BITS`) an independent observation also fails.
    uint8 public constant AMOUNT_FIELD = 3;
    uint8 public constant VARIANT_FIELD = 9;
    /// @dev The attribution rules that blame a failed mandate field: R60 (green), R61 (amber) and R62 (gray).
    uint8 public constant FIRST_FIELD_RULE = 60;
    uint8 public constant LAST_FIELD_RULE = 62;

    IKeelsonBondVault public immutable vault;
    IVerdictVerifier public immutable teeVerifier;
    IKeelsonValidationRegistry public immutable validations;
    EngineProofVerifier public immutable engineProofs;

    event SlashContested(bytes32 indexed disputeId, bytes32 indexed countersignDigest, uint8 fieldId);

    /// @notice The slash is not queued, or belongs to a batch, whose coverages have no recorded countersign.
    error NotContestable();
    /// @notice The verdict is not the one the slash was queued with.
    error VerdictMismatch();
    /// @notice The verdict's rule or field is one the engine proof does not cover.
    error NotAnEvaluationFault();
    /// @notice No countersign is recorded for the coverage.
    error NoCountersign();
    /// @notice No engine proof of the coverage's countersign is recorded.
    error NotProven();

    constructor(
        IKeelsonBondVault vault_,
        IVerdictVerifier teeVerifier_,
        IKeelsonValidationRegistry validations_,
        EngineProofVerifier engineProofs_
    ) {
        vault = vault_;
        teeVerifier = teeVerifier_;
        validations = validations_;
        engineProofs = engineProofs_;
    }

    /// @notice Whether the engine proof is complete evidence against a verdict of `ruleId` naming `fieldId`.
    function covers(uint8 ruleId, uint8 fieldId) public pure returns (bool) {
        return
            ruleId >= FIRST_FIELD_RULE && ruleId <= LAST_FIELD_RULE && fieldId != AMOUNT_FIELD
                && fieldId != VARIANT_FIELD;
    }

    /// @notice Vetoes the queued slash of verdict `v`, inside its veto window.
    function contest(KeelsonTypes.Verdict calldata v) external {
        IKeelsonBondVault.QueuedSlash memory q = vault.queuedSlashes(v.disputeId);
        if (q.status != IKeelsonBondVault.SlashStatus.Queued || q.batchId != 0) revert NotContestable();
        if (q.verdictDigest != teeVerifier.hashTypedData(KeelsonTypes.hash(v))) revert VerdictMismatch();
        if (!covers(v.ruleId, v.fieldId)) revert NotAnEvaluationFault();
        bytes32 digest = validations.requestOf(v.coverageId);
        if (digest == 0) revert NoCountersign();
        // The program commits the digest of the countersign it recomputed, `evalHash` included: a recorded proof of
        // the digest is a proof of that countersign.
        if (engineProofs.proven(digest) == 0) revert NotProven();
        emit SlashContested(v.disputeId, digest, v.fieldId);
        vault.vetoSlash(v.disputeId, "engine proof");
    }
}
