use serde::Serialize;
use serde_json::Value;

/// The trace format version.
pub const TRACE_VERSION: &str = "keelson.eval/1";

/// The outcome of an evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Deny,
}

/// The engine build that produced a trace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Engine {
    pub cedar_policy: String,
    pub lang: String,
    pub symcc: String,
    pub cvc5: String,
    pub oci_digest: String,
    pub canonicalizer: String,
}

/// The result of one policy, keyed by its `@id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FieldTrace {
    pub id: String,
    pub field: String,
    pub color: String,
    pub pass: bool,
    /// The context value the policy reads, in Cedar JSON form.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed: Option<Value>,
    /// The `Mandate` entity value the policy compares against, in Cedar JSON form.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bound: Option<Value>,
    pub evidence: Vec<String>,
}

/// A `keelson.eval/1` trace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Trace {
    pub v: String,
    pub engine: Engine,
    pub policy_set_hash: String,
    pub schema_hash: String,
    pub proof_bundle_hash: String,
    pub mandate_hash: String,
    pub cart_hash: String,
    /// The context passed to Cedar, in Cedar JSON form.
    pub context: Value,
    pub decision: Decision,
    /// The ids of the `forbid` policies that determined a deny, sorted.
    pub fired: Vec<String>,
    pub fields: Vec<FieldTrace>,
    /// Every error met while evaluating, sorted. Any error means deny.
    pub errors: Vec<String>,
    pub t_tee: String,
}

/// The trace as RFC 8785 canonical JSON.
///
/// # Panics
///
/// If the trace holds a number that is not a safe integer. Traces from [`crate::evaluate`] never
/// do: such numbers are carried as strings.
pub fn trace_jcs(t: &Trace) -> Vec<u8> {
    let value = serde_json::to_value(t).expect("a trace serializes to JSON");
    keelson_core::jcs(&value)
        .expect("a trace holds only safe integers")
        .into_bytes()
}
