//! The `Verdict` EIP-712 message for an attributed dispute, as the TEE legs sign it and
//! `KeelsonBondVault.slash` and `KeelsonReserve.payWarranty` check it.

use std::fmt;

use alloy_primitives::aliases::{U40, U96};
use alloy_primitives::{Address, B256, U256, keccak256};
use keelson_core::eip712::Verdict;
use keelson_core::{Dst, hash_object};

use crate::{AttributionError, Facts, attribute, attribution_policy_set_hash};

/// The `fieldId` of a verdict whose rule is not about a mandate field.
pub const NO_FIELD: u8 = 0xff;

/// The rules that blame a failed mandate field: R60 (green), R61 (amber) and R62 (gray).
const FIELD_RULES: [u8; 3] = [60, 61, 62];

/// What a verdict carries besides the attribution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerdictInput<'a> {
    /// The PayPal dispute id, `PP-D-…`.
    pub paypal_dispute_id: &'a str,
    pub coverage_id: B256,
    pub agent_id: U256,
    pub payee: Address,
    /// PYUSD base units.
    pub amount: u128,
    /// The `failedFieldsMask` bit of the failed field for R60–R62, else [`NO_FIELD`].
    pub field_id: u8,
    pub evidence_hash: B256,
    pub checkpoint_root: B256,
    /// Unix seconds.
    pub issued_at: u64,
    /// Unix seconds.
    pub deadline: u64,
}

/// Why a verdict could not be built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerdictError {
    Attribution(AttributionError),
    EmptyDisputeId,
    /// `amount` does not fit `uint96`.
    AmountTooLarge,
    /// `issuedAt` or `deadline` does not fit `uint40`.
    TimeTooLarge,
    DeadlineNotAfterIssue,
    /// The rule blames a field and no field id was given.
    FieldRequired(u8),
    /// The rule blames no field and a field id was given.
    FieldNotApplicable(u8),
}

impl fmt::Display for VerdictError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Attribution(e) => e.fmt(f),
            Self::EmptyDisputeId => f.write_str("the PayPal dispute id is empty"),
            Self::AmountTooLarge => f.write_str("amount does not fit uint96"),
            Self::TimeTooLarge => f.write_str("issuedAt or deadline does not fit uint40"),
            Self::DeadlineNotAfterIssue => f.write_str("deadline is not after issuedAt"),
            Self::FieldRequired(rule) => write!(f, "rule R{rule:02} needs a field id"),
            Self::FieldNotApplicable(rule) => write!(f, "rule R{rule:02} takes no field id"),
        }
    }
}

impl std::error::Error for VerdictError {}

/// `keccak256(paypalDisputeId ‖ coverageId)`, the packed encoding: the dispute's nullifier.
pub fn dispute_id(paypal_dispute_id: &str, coverage_id: B256) -> B256 {
    let mut packed = Vec::with_capacity(paypal_dispute_id.len() + 32);
    packed.extend_from_slice(paypal_dispute_id.as_bytes());
    packed.extend_from_slice(coverage_id.as_slice());
    keccak256(packed)
}

/// `H("keelson/verdict/v1", JCS(facts))`.
pub fn inputs_hash(facts: &Facts) -> B256 {
    let value = serde_json::to_value(facts).expect("facts serialize");
    hash_object(Dst::Verdict, &value)
        .expect("facts hold no numbers")
        .into()
}

/// The `Verdict` for the dispute `facts` describe: attributed by [`attribute`], with
/// `inputsHash` = [`inputs_hash`] and `policySetHash` = [`attribution_policy_set_hash`].
pub fn verdict(facts: &Facts, input: &VerdictInput) -> Result<Verdict, VerdictError> {
    let attribution = attribute(facts).map_err(VerdictError::Attribution)?;
    if input.paypal_dispute_id.is_empty() {
        return Err(VerdictError::EmptyDisputeId);
    }
    let amount = U96::try_from(input.amount).map_err(|_| VerdictError::AmountTooLarge)?;
    let time = |t: u64| U40::try_from(t).map_err(|_| VerdictError::TimeTooLarge);
    let (issued_at, deadline) = (time(input.issued_at)?, time(input.deadline)?);
    if input.deadline <= input.issued_at {
        return Err(VerdictError::DeadlineNotAfterIssue);
    }
    let rule = attribution.rule;
    match (FIELD_RULES.contains(&rule), input.field_id == NO_FIELD) {
        (true, true) => return Err(VerdictError::FieldRequired(rule)),
        (false, false) => return Err(VerdictError::FieldNotApplicable(rule)),
        _ => {}
    }
    Ok(Verdict {
        disputeId: dispute_id(input.paypal_dispute_id, input.coverage_id),
        coverageId: input.coverage_id,
        agentId: input.agent_id,
        payee: input.payee,
        amount,
        ruleId: rule,
        liable: attribution.liable as u8,
        fieldId: input.field_id,
        evidenceHash: input.evidence_hash,
        inputsHash: inputs_hash(facts),
        policySetHash: attribution_policy_set_hash().into(),
        checkpointRoot: input.checkpoint_root,
        issuedAt: issued_at,
        deadline,
    })
}
