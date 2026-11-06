use std::fmt;

use cedar_policy::{Policy, PolicyId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// A constraint a user or operator adds on top of the mandate. Each one only ever denies.
///
/// This is a closed set: anything else, including a `permit`, fails to deserialize.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Extra {
    /// Denies a cart with a line priced above `minor` per unit.
    MaxUnitPrice { minor: i64 },
    /// Denies a cart from merchant `id`.
    DenyMerchant { id: String },
    /// Denies a cart with a line in category `id`.
    DenyCategory { id: String },
    /// Denies a cart whose return window is shorter than `min` days.
    RequireReturnDays { min: i64 },
}

/// Why an extra is rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvalidExtra {
    /// The price is not a safe integer above zero.
    Price,
    /// The number of days is not a non-negative safe integer.
    ReturnDays,
    /// The merchant id is not `mrc_` followed by a valid mandate merchant id.
    MerchantId,
    /// The category id is not `gpt:` followed by a decimal id.
    CategoryId,
    /// Cedar rejected the policy built from the extra.
    Cedar,
}

/// The first extra that cannot be compiled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExtrasError {
    /// The position of the extra in its list.
    pub index: usize,
    pub reason: InvalidExtra,
}

impl fmt::Display for ExtrasError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "extra {}: {:?}", self.index, self.reason)
    }
}

impl std::error::Error for ExtrasError {}

impl Extra {
    /// The `@field` annotation, the context attribute read, the comparison and the literal.
    fn parts(&self) -> (&'static str, &'static str, &'static str, Value) {
        match self {
            Self::MaxUnitPrice { minor } => ("total", "max_unit_minor", ">", json!(minor)),
            Self::DenyMerchant { id } => ("merchant", "merchant", "==", json!(id)),
            Self::DenyCategory { id } => ("category", "categories", "contains", json!(id)),
            Self::RequireReturnDays { min } => ("return_policy", "return_days", "<", json!(min)),
        }
    }

    fn check(&self) -> Result<(), InvalidExtra> {
        let ok = match self {
            Self::MaxUnitPrice { minor } => (1..=MAX_SAFE_INTEGER).contains(minor),
            Self::RequireReturnDays { min } => (0..=MAX_SAFE_INTEGER).contains(min),
            Self::DenyMerchant { id } => id
                .strip_prefix("mrc_")
                .is_some_and(|rest| !rest.is_empty() && keelson_mandate::is_merchant_id(id)),
            Self::DenyCategory { id } => id.strip_prefix("gpt:").is_some_and(|n| {
                (1..=10).contains(&n.len())
                    && n.bytes().all(|b| b.is_ascii_digit())
                    && !n.starts_with('0')
            }),
        };
        ok.then_some(()).ok_or(match self {
            Self::MaxUnitPrice { .. } => InvalidExtra::Price,
            Self::RequireReturnDays { .. } => InvalidExtra::ReturnDays,
            Self::DenyMerchant { .. } => InvalidExtra::MerchantId,
            Self::DenyCategory { .. } => InvalidExtra::CategoryId,
        })
    }

    /// The context attribute the policy reads and the constant it compares it with.
    pub(crate) fn binding(&self) -> (&'static str, Value) {
        let (_, attr, _, literal) = self.parts();
        (attr, literal)
    }

    /// The policy in Cedar's JSON form, so string values are data and never policy syntax.
    fn est(&self, id: &str) -> Value {
        let (field, attr, op, literal) = self.parts();
        json!({
            "annotations": { "id": id, "field": field, "color": "green" },
            "effect": "forbid",
            "principal": { "op": "All" },
            "action": { "op": "==", "entity": { "type": "Keelson::Action", "id": "checkout" } },
            "resource": { "op": "All" },
            "conditions": [{
                "kind": "when",
                "body": { op: {
                    "left": { ".": { "left": { "Var": "context" }, "attr": attr } },
                    "right": { "Value": literal },
                } },
            }],
        })
    }
}

/// Compiles extras to `(id, policy)` pairs with ids `extra.<n>`, `n` being the extra's position.
///
/// Each policy is rendered to text and parsed back, and kept only if the parse matches the policy
/// built from its JSON form, so the text is exactly what is evaluated.
pub(crate) fn compile(dsl: &[Extra]) -> Result<Vec<(String, Policy, String)>, ExtrasError> {
    dsl.iter()
        .enumerate()
        .map(|(index, extra)| {
            let fail = |reason| ExtrasError { index, reason };
            extra.check().map_err(fail)?;
            let id = format!("extra.{index}");
            let built = Policy::from_json(Some(PolicyId::new(&id)), extra.est(&id))
                .map_err(|_| fail(InvalidExtra::Cedar))?;
            let text = built.to_string();
            let parsed = Policy::parse(Some(PolicyId::new(&id)), &text)
                .map_err(|_| fail(InvalidExtra::Cedar))?;
            match (parsed.to_json(), built.to_json()) {
                (Ok(a), Ok(b)) if a == b => Ok((id, parsed, text)),
                _ => Err(fail(InvalidExtra::Cedar)),
            }
        })
        .collect()
}

/// Compiles extras to `(id, text)` pairs of Cedar `forbid` policies, with ids `extra.<n>`, `n`
/// being the extra's position.
///
/// Each policy carries `@id`, `@field` and `@color("green")`, and compares one context attribute
/// with a constant.
pub fn compile_extras(dsl: &[Extra]) -> Result<Vec<(String, String)>, ExtrasError> {
    Ok(compile(dsl)?
        .into_iter()
        .map(|(id, _, text)| (id, text))
        .collect())
}
