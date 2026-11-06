//! The Keelson Cedar schema, the constant policy set, the `Mandate` entity builder and the
//! fail-closed evaluator that emits the `keelson.eval/1` trace.
//!
//! The policy set is a base `permit` plus one `forbid` per mandate field. Each policy carries
//! `@id`, `@field` and `@color` annotations, and its Cedar policy id is its `@id`.

mod entity;
mod evaluate;
mod hashes;
mod trace;

pub use entity::{agent_uid, cedar_datetime, mandate_agent, mandate_entity, variant_expr};
pub use evaluate::{EngineMeta, EvalInput, FieldId, evaluate, evaluate_context};
pub use hashes::{policy_set_hash, policy_set_hash_tag, schema_hash, schema_hash_tag};
pub use trace::{Decision, Engine, FieldTrace, TRACE_VERSION, Trace, trace_jcs};

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;
use std::sync::OnceLock;

use cedar_policy::{Policy, PolicyId, PolicySet, Schema};

/// The policy set source, `policy/keelson.cedar`.
pub const POLICY_SET_SRC: &str = include_str!("../policy/keelson.cedar");
/// The schema source, `policy/keelson.cedarschema`.
pub const SCHEMA_SRC: &str = include_str!("../policy/keelson.cedarschema");

/// Errors building the policy inputs from a mandate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyError {
    /// A mandate field is missing or has the wrong type.
    Mandate { field: String, reason: String },
    /// Cedar rejected a value.
    Cedar(String),
}

impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mandate { field, reason } => write!(f, "{field}: {reason}"),
            Self::Cedar(e) => write!(f, "cedar: {e}"),
        }
    }
}

impl std::error::Error for PolicyError {}

/// The parsed schema.
pub fn schema() -> &'static Schema {
    static SCHEMA: OnceLock<Schema> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        Schema::from_cedarschema_str(SCHEMA_SRC)
            .expect("the bundled schema parses")
            .0
    })
}

/// The source text of each policy, keyed by its `@id` annotation.
pub fn policy_texts() -> &'static BTreeMap<String, String> {
    static TEXTS: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    TEXTS.get_or_init(|| {
        let parsed = PolicySet::from_str(POLICY_SET_SRC).expect("the bundled policy set parses");
        let texts: BTreeMap<_, _> = parsed
            .policies()
            .map(|p| {
                let id = p.annotation("id").expect("every policy has an @id");
                (id.to_owned(), p.to_string())
            })
            .collect();
        assert_eq!(
            texts.len(),
            parsed.policies().count(),
            "@id values are unique"
        );
        texts
    })
}

/// The policy set, parsed once from [`policy_texts`] so each policy id is its `@id`.
pub fn policies() -> &'static PolicySet {
    static POLICIES: OnceLock<PolicySet> = OnceLock::new();
    POLICIES.get_or_init(|| {
        PolicySet::from_policies(policy_texts().iter().map(|(id, text)| {
            Policy::parse(Some(PolicyId::new(id)), text).expect("each bundled policy parses")
        }))
        .expect("policy ids are unique")
    })
}
