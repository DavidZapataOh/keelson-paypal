//! What a `Countersign` commits to, recomputed from the inputs the engine evaluated.
//!
//! [`recompute`] runs the canonicalizer and the policy evaluation exactly as the TEE legs do, so a
//! third party (the SP1 zkVM in a dispute) can recompute a countersign's `evalHash` and digest.

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use alloy_primitives::aliases::U40;
use alloy_primitives::{Address, B256, U256};
use alloy_sol_types::SolStruct;
use keelson_canon::{Cart, Context, Deny, PayPalUnit, canonicalize, cart_hash};
use keelson_core::eip712::Countersign;
use keelson_core::{AcirField, Dst, currency_numeric};
use keelson_mandate::{CATEGORY_IDS, Fr, decode_mandate, h_sd, mandate_challenge, merchant_leaf};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::macros::format_description;

use crate::hashes::hex;
use crate::{
    Decision, Engine, EngineMeta, EvalInput, TRACE_VERSION, Trace, agent_uid, evaluate,
    policy_set_hash, policy_set_hash_tag, schema_hash_tag, trace_jcs,
};

/// The `failedFieldsMask` bit of each policy `@id`. Append-only.
pub const FIELD_BITS: [(&str, u8); 12] = [
    ("agent", 0),
    ("sanity", 1),
    ("currency", 2),
    ("amount", 3),
    ("budget", 4),
    ("merchant", 5),
    ("window", 6),
    ("quantity", 7),
    ("category", 8),
    ("variant", 9),
    ("returns", 10),
    ("returns_free", 11),
];
/// Set when any fired policy is outside the base table (a user extra such as `extra.0`).
pub const BIT_EXTRA: u8 = 28;
/// Set when the canonicalizer denied the cart.
pub const BIT_CANON: u8 = 29;
/// Set when Cedar reported diagnostics errors.
pub const BIT_CEDAR_ERROR: u8 = 30;
/// Set when the PayPal order check failed.
pub const BIT_PAYPAL: u8 = 31;

/// `category` of a cart with no single category in `CATEGORY_IDS`.
pub const NO_CATEGORY: u8 = 255;

/// Builds `failedFieldsMask` from the fired policy ids and the fault flags.
///
/// Ids outside [`FIELD_BITS`] set [`BIT_EXTRA`], except the `base` permit.
pub fn failed_fields_mask(
    fired: &[impl AsRef<str>],
    errors: bool,
    canon: bool,
    paypal: bool,
) -> u32 {
    let mut mask = 0;
    for id in fired.iter().map(AsRef::as_ref) {
        match FIELD_BITS.iter().find(|(f, _)| *f == id) {
            Some((_, bit)) => mask |= 1 << bit,
            None if id == "base" => {}
            None => mask |= 1 << BIT_EXTRA,
        }
    }
    for (set, bit) in [
        (canon, BIT_CANON),
        (errors, BIT_CEDAR_ERROR),
        (paypal, BIT_PAYPAL),
    ] {
        if set {
            mask |= 1 << bit;
        }
    }
    mask
}

/// The bit index in `CATEGORY_IDS` of the cart's only category, or [`NO_CATEGORY`].
pub fn category(cart: &Cart) -> u8 {
    let ids: BTreeSet<&str> = cart.lines.iter().map(|l| l.category.as_str()).collect();
    match ids.into_iter().collect::<Vec<_>>()[..] {
        [id] => CATEGORY_IDS
            .iter()
            .position(|c| *c == id)
            .and_then(|i| u8::try_from(i).ok())
            .unwrap_or(NO_CATEGORY),
        _ => NO_CATEGORY,
    }
}

/// `evalHash = H("keelson/eval/v1", trace)`: SHA-256 over the tag, a zero byte and the trace JCS.
pub fn eval_hash(trace_jcs: &[u8]) -> [u8; 32] {
    Sha256::new()
        .chain_update(Dst::Eval.as_str())
        .chain_update([0])
        .chain_update(trace_jcs)
        .finalize()
        .into()
}

/// The trace of a cart denied for `reason` before any policy ran.
pub fn deny_trace(
    reason: &str,
    now: OffsetDateTime,
    mandate_hash: &[u8; 32],
    cart_hash: &[u8; 32],
    meta: &EngineMeta,
) -> Trace {
    Trace {
        v: TRACE_VERSION.into(),
        engine: Engine {
            cedar_policy: meta.cedar_policy.clone(),
            lang: meta.lang.clone(),
            symcc: meta.symcc.clone(),
            cvc5: meta.cvc5.clone(),
            oci_digest: meta.oci_digest.clone(),
            canonicalizer: meta.canonicalizer.clone(),
        },
        policy_set_hash: policy_set_hash_tag(),
        schema_hash: schema_hash_tag(),
        proof_bundle_hash: meta.proof_bundle_hash.clone(),
        extras_hash: None,
        mandate_hash: hex("0x", mandate_hash),
        cart_hash: hex("sha256:", cart_hash),
        context: json!({}),
        decision: Decision::Deny,
        fired: Vec::new(),
        fields: Vec::new(),
        errors: vec![reason.to_owned()],
        t_tee: now
            .to_offset(time::UtcOffset::UTC)
            .format(format_description!(
                "[year]-[month]-[day]T[hour]:[minute]:[second]Z"
            ))
            .unwrap_or_default(),
    }
}

/// The `canon.<reason>` error of a cart the canonicalizer denied.
pub fn canon_reason(deny: Deny) -> String {
    let reason = serde_json::to_value(deny).expect("Deny serializes to a string");
    format!("canon.{}", reason.as_str().unwrap_or_default())
}

/// The trace of a cart: the policy evaluation of its canonical context, or the canonicalizer's
/// deny. A PayPal deny is decided before this and is not covered.
pub fn cart_trace(
    context: &Result<Context, Deny>,
    input: impl FnOnce(Context) -> EvalInput,
    now: OffsetDateTime,
    mandate_hash: &[u8; 32],
    cart_hash: &[u8; 32],
    meta: &EngineMeta,
) -> Trace {
    match context {
        Ok(context) => evaluate(&input(context.clone()), meta),
        Err(deny) => deny_trace(&canon_reason(*deny), now, mandate_hash, cart_hash, meta),
    }
}

/// Everything a countersign was computed from, as it is stored for a dispute.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CountersignInput {
    /// The registered mandate: its SD-JWT payload and every disclosure.
    pub payload_sd: Value,
    pub disclosures: Vec<String>,
    pub cart: Cart,
    pub unit: PayPalUnit,
    pub evidence: BTreeMap<String, Vec<String>>,
    /// The leg A observation the countersign was made under.
    pub now_ms: i64,
    pub budget_left_minor: i64,
    /// Signed fields the evaluation does not decide.
    pub request_id: B256,
    pub evidence_root: B256,
    pub expires_at: u64,
    /// The EIP-712 domain.
    pub chain_id: u64,
    pub verifying_contract: Address,
    /// The engine image the trace names.
    pub oci_digest: String,
    pub canonicalizer: String,
}

/// A recomputed countersign.
#[derive(Clone)]
pub struct Recomputed {
    pub trace: Trace,
    pub trace_jcs: Vec<u8>,
    pub countersign: Countersign,
    /// The EIP-712 signing hash of `countersign`.
    pub digest: [u8; 32],
}

/// Why a countersign cannot be recomputed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecomputeError {
    Mandate,
    Cart,
    Merchant,
    Clock,
    Domain,
}

/// Recomputes the countersign the engine signs for `input`, on the canonicalizer and policy path.
pub fn recompute(input: &CountersignInput) -> Result<Recomputed, RecomputeError> {
    let mandate = decode_mandate(&input.payload_sd, &input.disclosures)
        .map_err(|_| RecomputeError::Mandate)?;
    let commitment = mandate["zk"]["commitment"]
        .as_str()
        .and_then(|c| B256::from_str(c).ok())
        .ok_or(RecomputeError::Mandate)?;
    let h = h_sd(&input.payload_sd).map_err(|_| RecomputeError::Mandate)?;
    let mandate_hash = mandate_challenge(&h, &Fr::from_be_bytes_reduce(commitment.as_slice()));
    let operator = &mandate["agent"]["operator"];
    let agent_id = operator["agent_id"].as_str().unwrap_or_default();
    let agent = agent_uid(
        operator["agent_registry"].as_str().unwrap_or_default(),
        agent_id,
    )
    .ok_or(RecomputeError::Mandate)?;
    let agent_id = U256::from_str_radix(agent_id, 10).map_err(|_| RecomputeError::Mandate)?;
    let cart = &input.cart;
    let cart_digest = cart_hash(cart).map_err(|_| RecomputeError::Cart)?;
    let merchant = merchant_leaf(&cart.merchant).map_err(|_| RecomputeError::Merchant)?;
    let now = OffsetDateTime::from_unix_timestamp_nanos(i128::from(input.now_ms) * 1_000_000)
        .map_err(|_| RecomputeError::Clock)?;
    let now_s = input.now_ms.div_euclid(1000);
    let meta = EngineMeta::current(&input.oci_digest, &input.canonicalizer);

    let context = canonicalize(cart, &input.unit);
    let amount = context.as_ref().map_or(0, |c| c.total_minor);
    let amount = u64::try_from(amount).map_err(|_| RecomputeError::Cart)?;
    let trace = cart_trace(
        &context,
        |context| EvalInput {
            mandate: mandate.clone(),
            budget_left_minor: input.budget_left_minor,
            agent,
            context,
            now,
            evidence: input.evidence.clone(),
            mandate_hash,
            cart_hash: cart_digest,
        },
        now,
        &mandate_hash,
        &cart_digest,
        &meta,
    );
    let trace_jcs = trace_jcs(&trace);
    let canon = context.is_err();
    let allow = trace.decision == Decision::Allow;
    let countersign = Countersign {
        requestId: input.request_id,
        mandateHash: B256::new(mandate_hash),
        mandateCommitment: commitment,
        cartHash: B256::new(cart_digest),
        agentId: agent_id,
        merchantId: B256::new(
            merchant
                .to_be_bytes()
                .try_into()
                .expect("a BN254 element is 32 bytes"),
        ),
        amount,
        currency: currency_numeric(&cart.currency).unwrap_or(0),
        category: category(cart),
        evidenceRoot: input.evidence_root,
        evalHash: B256::new(eval_hash(&trace_jcs)),
        policySetHash: B256::new(policy_set_hash()),
        decision: if allow { 1 } else { 2 },
        failedFieldsMask: failed_fields_mask(
            &trace.fired,
            !canon && !trace.errors.is_empty(),
            canon,
            false,
        ),
        issuedAt: uint40(now_s)?,
        expiresAt: uint40(i64::try_from(input.expires_at).map_err(|_| RecomputeError::Clock)?)?,
    };
    let domain = keelson_core::domain(input.chain_id, input.verifying_contract)
        .map_err(|_| RecomputeError::Domain)?;
    let digest = countersign.eip712_signing_hash(&domain).0;
    Ok(Recomputed {
        trace,
        trace_jcs,
        countersign,
        digest,
    })
}

fn uint40(seconds: i64) -> Result<U40, RecomputeError> {
    u64::try_from(seconds)
        .ok()
        .and_then(|s| U40::try_from(s).ok())
        .ok_or(RecomputeError::Clock)
}
