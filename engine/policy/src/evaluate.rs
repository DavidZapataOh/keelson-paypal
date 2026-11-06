use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use cedar_policy::{
    AuthorizationError, Authorizer, Context, Effect, Entities, Entity, EntityUid, PolicyId,
    Request, Response,
};
use keelson_canon::Variant;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use time::macros::format_description;

use crate::entity::attributes;
use crate::hashes::hex;
use crate::trace::{Decision, Engine, FieldTrace, TRACE_VERSION, Trace};
use crate::{
    agent_uid, cedar_datetime, mandate_entity, policies, policy_set_hash_tag, policy_texts, schema,
    schema_hash_tag,
};

/// A policy `@field` value.
pub type FieldId = String;

/// Everything one evaluation reads.
#[derive(Debug, Clone)]
pub struct EvalInput {
    /// The fully decoded mandate.
    pub mandate: Value,
    pub budget_left_minor: i64,
    /// The agent principal id, as [`crate::mandate_agent`] formats it.
    pub agent: String,
    pub context: keelson_canon::Context,
    /// The TEE clock.
    pub now: OffsetDateTime,
    /// The evidence sources for each field. A `ucp:` or `zktls:` source raises its color to green.
    pub evidence: BTreeMap<FieldId, Vec<String>>,
    /// The mandate challenge `M`.
    pub mandate_hash: [u8; 32],
    pub cart_hash: [u8; 32],
}

/// The engine build recorded in every trace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineMeta {
    pub cedar_policy: String,
    pub lang: String,
    pub symcc: String,
    pub cvc5: String,
    pub oci_digest: String,
    pub canonicalizer: String,
    pub proof_bundle_hash: String,
}

impl EngineMeta {
    /// The linked Cedar SDK and language versions, plus the values known only at build time.
    pub fn new(
        symcc: &str,
        cvc5: &str,
        oci_digest: &str,
        canonicalizer: &str,
        proof_bundle_hash: &str,
    ) -> Self {
        let lang = cedar_policy::get_lang_version();
        Self {
            cedar_policy: cedar_policy::get_sdk_version().to_string(),
            lang: format!("{}.{}", lang.major, lang.minor),
            symcc: symcc.to_owned(),
            cvc5: cvc5.to_owned(),
            oci_digest: oci_digest.to_owned(),
            canonicalizer: canonicalizer.to_owned(),
            proof_bundle_hash: proof_bundle_hash.to_owned(),
        }
    }
}

const AGENT_TYPE: &str = "Keelson::Agent";
const ACTION: &str = r#"Keelson::Action::"checkout""#;
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// The context and entity attributes each policy reads, shown as `observed` and `bound`. One key
/// is shown as its value, several as a record of them.
const BINDINGS: [(&str, &[&str], &[&str]); 12] = [
    ("agent", &[], &["agent"]),
    ("sanity", &["max_line_qty", "total_minor"], &[]),
    ("currency", &["currency"], &["currency"]),
    ("amount", &["total_minor"], &["max_total_minor"]),
    ("budget", &["total_minor"], &["budget_left_minor"]),
    ("merchant", &["merchant"], &["merchants"]),
    ("window", &["now"], &["expires_at", "not_before"]),
    ("quantity", &["max_line_qty"], &["max_qty_per_line"]),
    ("category", &["categories"], &["categories"]),
    ("variant", &["variants"], &["variants"]),
    ("returns", &["return_days"], &["min_return_days"]),
    (
        "returns_free",
        &["returns_free"],
        &["returns_free_required"],
    ),
];

/// Errors met while evaluating, and the policies they keep from passing.
#[derive(Default)]
struct Faults {
    errors: Vec<String>,
    policies: BTreeSet<String>,
}

impl Faults {
    fn add(&mut self, policy: Option<&str>, error: String) {
        self.errors.push(error);
        self.policies.extend(policy.map(str::to_owned));
    }
}

/// Evaluates a cart against a mandate. Fails closed: any error denies and is recorded.
///
/// The context passed to Cedar is `input.context` projected onto the attributes the mandate
/// constrains: each variant keeps its `size` only when `keelson.attributes` requires a `size_us`,
/// and its `color` only when it requires a `color` (a value of `any` requires nothing). The
/// quantities of variants that become equal are added with overflow checks, and `max_line_qty` is
/// the largest of those sums, or 0 for an empty cart.
pub fn evaluate(input: &EvalInput, meta: &EngineMeta) -> Trace {
    let mut faults = Faults::default();
    let context = project(input, &mut faults);
    run(input, context, faults, meta)
}

/// Evaluates `context`, a context in Cedar JSON form such as a trace records, in place of the
/// projection of `input.context`. It replays a recorded evaluation.
pub fn evaluate_context(input: &EvalInput, context: Value, meta: &EngineMeta) -> Trace {
    run(input, context, Faults::default(), meta)
}

fn project(input: &EvalInput, faults: &mut Faults) -> Value {
    let c = &input.context;
    // An unreadable mandate denies anyway; its error is recorded when the entity is built.
    let (size, color) = attributes(&input.mandate).map_or((true, true), |(size, color)| {
        (size.is_some(), color.is_some())
    });
    let projected = |v: &Variant| Variant {
        sku: v.sku.clone(),
        size: v.size.clone().filter(|_| size),
        color: v.color.clone().filter(|_| color),
    };
    let variants: BTreeSet<Variant> = c.variants.iter().map(projected).collect();

    let mut max_line_qty = c.max_line_qty;
    if c.quantities.keys().ne(c.variants.iter()) {
        faults.add(
            Some("quantity"),
            "context.quantities: does not match context.variants".to_owned(),
        );
    } else {
        let mut sums: BTreeMap<Variant, i64> = BTreeMap::new();
        let mut overflow = false;
        for (v, &qty) in &c.quantities {
            let sum = sums.entry(projected(v)).or_insert(0);
            match sum.checked_add(qty) {
                Some(s) => *sum = s,
                None => overflow = true,
            }
        }
        if overflow {
            faults.add(
                Some("quantity"),
                "context.max_line_qty: overflow".to_owned(),
            );
        } else {
            max_line_qty = sums.into_values().max().unwrap_or(0);
        }
    }

    let now = match cedar_datetime(input.now) {
        Ok(now) => json!({ "__extn": { "fn": "datetime", "arg": now } }),
        Err(e) => {
            faults.add(Some("window"), format!("now: {e}"));
            Value::Null
        }
    };
    json!({
        "currency": c.currency,
        "total_minor": c.total_minor,
        "merchant": c.merchant,
        "categories": c.categories,
        "variants": variants,
        "max_line_qty": max_line_qty,
        "return_days": c.return_days,
        "returns_free": c.returns_free,
        "now": now,
    })
}

fn run(input: &EvalInput, context: Value, mut faults: Faults, meta: &EngineMeta) -> Trace {
    let context = safe(context);

    let non_empty = context["variants"]
        .as_array()
        .is_some_and(|v| !v.is_empty());
    let categories = context["categories"].as_array();
    if non_empty && categories.is_some_and(|c| c.is_empty() || c.iter().any(|c| c == "")) {
        faults.add(
            Some("category"),
            "context.categories: empty set or id for a non-empty cart".to_owned(),
        );
    }

    let entity = mandate_entity(&input.mandate, input.budget_left_minor)
        .map_err(|e| faults.add(None, format!("mandate: {e}")))
        .ok();
    let bounds = entity
        .as_ref()
        .and_then(|e| e.to_json_value().ok())
        .map(|e| safe(e["attrs"].clone()));
    let response = entity.and_then(|e| {
        authorize(&input.agent, &context, e)
            .map_err(|e| faults.add(None, e))
            .ok()
    });

    let mut fired = Vec::new();
    let mut allowed = false;
    if let Some(r) = &response {
        allowed = r.decision() == cedar_policy::Decision::Allow;
        for id in r.diagnostics().reason() {
            if policies().policy(id).map(|p| p.effect()) == Some(Effect::Forbid) {
                fired.push(id.to_string());
            }
        }
        for e in r.diagnostics().errors() {
            let AuthorizationError::PolicyEvaluationError(pe) = e;
            faults.add(Some(pe.policy_id().as_ref()), e.to_string());
        }
    }
    fired.sort();
    faults.errors.sort();
    let decision = if allowed && fired.is_empty() && faults.errors.is_empty() {
        Decision::Allow
    } else {
        Decision::Deny
    };

    let principal = json!({ "__entity": { "type": AGENT_TYPE, "id": input.agent } });
    let fields = policy_texts()
        .keys()
        .filter(|id| *id != "base")
        .map(|id| {
            let policy = policies().policy(&PolicyId::new(id));
            let annotation = |key| {
                policy
                    .and_then(|p| p.annotation(key))
                    .unwrap_or_default()
                    .to_owned()
            };
            let field = annotation("field");
            let evidence = input.evidence.get(&field).cloned().unwrap_or_default();
            let proven = evidence
                .iter()
                .any(|e| e.starts_with("ucp:") || e.starts_with("zktls:"));
            let (observed, bound) =
                BINDINGS
                    .iter()
                    .find(|(b, ..)| b == id)
                    .map_or((None, None), |(_, ctx, attrs)| {
                        let observed = if id == "agent" {
                            Some(principal.clone())
                        } else {
                            pick(&context, ctx)
                        };
                        (observed, bounds.as_ref().and_then(|b| pick(b, attrs)))
                    });
            FieldTrace {
                id: id.clone(),
                color: if proven {
                    "green".to_owned()
                } else {
                    annotation("color")
                },
                field,
                pass: response.is_some() && !fired.contains(id) && !faults.policies.contains(id),
                observed,
                bound,
                evidence,
            }
        })
        .collect();

    let t_tee = input
        .now
        .to_offset(time::UtcOffset::UTC)
        .format(format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second]Z"
        ))
        .unwrap_or_default();
    Trace {
        v: TRACE_VERSION.to_owned(),
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
        mandate_hash: format!("0x{}", hex(&input.mandate_hash)),
        cart_hash: format!("sha256:{}", hex(&input.cart_hash)),
        context,
        decision,
        fired,
        fields,
        errors: faults.errors,
        t_tee,
    }
}

/// Builds the request against the schema and runs the authorizer.
fn authorize(agent: &str, context: &Value, entity: Entity) -> Result<Response, String> {
    let action = EntityUid::from_str(ACTION).map_err(|e| format!("action: {e}"))?;
    let principal = agent_uid(agent).map_err(|e| format!("agent: {e}"))?;
    let resource = entity.uid();
    let context = Context::from_json_value(context.clone(), Some((schema(), &action)))
        .map_err(|e| format!("context: {e}"))?;
    let request = Request::new(principal, action, resource, context, Some(schema()))
        .map_err(|e| format!("request: {e}"))?;
    let entities =
        Entities::from_entities([entity], Some(schema())).map_err(|e| format!("entities: {e}"))?;
    Ok(Authorizer::new().is_authorized(&request, policies(), &entities))
}

fn pick(source: &Value, keys: &[&str]) -> Option<Value> {
    match keys {
        [] => None,
        [key] => source.get(*key).cloned(),
        keys => Some(Value::Object(
            keys.iter()
                .filter_map(|&k| Some((k.to_owned(), source.get(k)?.clone())))
                .collect::<Map<_, _>>(),
        )),
    }
}

/// Carries every number that is not a safe integer as its decimal string, so the trace always
/// has a JCS form. Cedar then rejects the string where it expects a `Long`.
fn safe(value: Value) -> Value {
    match value {
        Value::Number(n) => match n.as_i64() {
            Some(i) if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&i) => Value::Number(n),
            _ => Value::String(n.to_string()),
        },
        Value::Array(items) => Value::Array(items.into_iter().map(safe).collect()),
        Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, safe(v))).collect()),
        other => other,
    }
}
