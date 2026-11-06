use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;
use std::str::FromStr;
use std::sync::OnceLock;

use cedar_policy::{
    AuthorizationError, Authorizer, Context, Effect, Entities, EntityUid, PolicyId, PolicySet,
    Request, Response, RestrictedExpression,
};
use keelson_canon::Variant;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::macros::format_description;

use crate::entity::{attributes, clock_ms};
use crate::extras::{Extra, InvalidExtra, compile};
use crate::hashes::hex;
use crate::trace::{Decision, Engine, FieldTrace, TRACE_VERSION, Trace};
use crate::{
    MAX_SAFE_INTEGER, PolicyError, agent_entity_uid, mandate_entity, policies, policy_set_hash_tag,
    policy_texts, safe_int, schema, schema_hash_tag, variant_expr,
};

/// A policy `@field` value.
pub type FieldId = String;

/// Everything one evaluation reads.
#[derive(Debug, Clone)]
pub struct EvalInput {
    /// The mandate as [`keelson_mandate::decode_mandate`] returns it, or the claims of an open
    /// mandate that [`keelson_mandate::verify_credential`] verified. The entity builder reads only
    /// what the policies need and does not re-check the rest of the format.
    pub mandate: Value,
    /// The budget left on the mandate, from the spending ledger; capped at `payment.budget.max`.
    pub budget_left_minor: i64,
    /// The authenticated requester: the [`crate::agent_uid`] of the agent whose signature or
    /// ERC-8004 identity was verified for this request. It must never be derived from the
    /// mandate under evaluation ([`crate::mandate_agent`]), or the `agent` policy compares the
    /// mandate with itself and can never deny.
    pub agent: String,
    pub context: keelson_canon::Context,
    /// The TEE clock.
    pub now: OffsetDateTime,
    /// The evidence sources for each field. A `ucp:` or `zktls:` source raises its color to green,
    /// so those sources must come only from the engine's own verifiers (a checked UCP merchant
    /// signature, a checked zkTLS proof): the evaluator trusts them as given.
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

/// The context and entity attributes each policy reads, shown as `observed` and `bound`. One key
/// is shown as its value, several as a record of them.
const BINDINGS: [(&str, &[&str], &[&str]); 12] = [
    ("agent", &[], &["agent"]),
    (
        "sanity",
        &["max_line_qty", "max_unit_minor", "total_minor"],
        &[],
    ),
    ("currency", &["currency"], &["currency"]),
    ("amount", &["total_minor"], &["max_total_minor"]),
    ("budget", &["total_minor"], &["budget_left_minor"]),
    ("merchant", &["merchant"], &["merchants"]),
    ("window", &["now_ms"], &["expires_at_ms", "not_before_ms"]),
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

/// The context attributes of the `checkout` action and their types.
const CONTEXT: [(&str, Kind); 10] = [
    ("currency", Kind::String),
    ("total_minor", Kind::Long),
    ("merchant", Kind::String),
    ("categories", Kind::Strings),
    ("variants", Kind::Variants),
    ("max_line_qty", Kind::Long),
    ("max_unit_minor", Kind::Long),
    ("return_days", Kind::Long),
    ("returns_free", Kind::Bool),
    ("now_ms", Kind::Long),
];

#[derive(Clone, Copy)]
enum Kind {
    String,
    Long,
    Bool,
    Strings,
    Variants,
}

impl Kind {
    fn accepts(self, v: &Value) -> bool {
        let strings = |v: &Value| v.as_array().is_some_and(|a| a.iter().all(Value::is_string));
        match self {
            Self::String => v.is_string(),
            Self::Long => safe_int(v).is_some(),
            Self::Bool => v.is_boolean(),
            Self::Strings => strings(v),
            Self::Variants => v.as_array().is_some_and(|a| {
                a.iter().all(|x| {
                    x.as_object().is_some_and(|o| {
                        o.get("sku").is_some_and(Value::is_string)
                            && o.iter().all(|(k, v)| {
                                ["sku", "size", "color"].contains(&k.as_str()) && v.is_string()
                            })
                    })
                })
            }),
        }
    }
}

/// Errors met while evaluating, and the policies they keep from passing.
#[derive(Default)]
struct Faults {
    errors: Vec<String>,
    policies: BTreeSet<String>,
}

impl Faults {
    fn add(&mut self, policy: Option<&str>, code: impl Into<String>) {
        self.errors.push(code.into());
        self.policies.extend(policy.map(str::to_owned));
    }
}

/// Evaluates a cart against a mandate. Fails closed: any error denies and is recorded.
///
/// An allow covers the mandate fields the policy set checks, and nothing the caller does before
/// it. The caller must first:
/// - decode the mandate strictly (see [`EvalInput::mandate`]) and authenticate the agent (see
///   [`EvalInput::agent`]);
/// - enforce `payment.allowed_payees` against the PayPal payee, which no policy reads;
/// - map that payee to the `mrc_*` merchant id it passes as `context.merchant`.
///
/// The context passed to Cedar is `input.context` projected onto the attributes the mandate
/// constrains: each variant keeps its `size` only when `keelson.attributes` requires a `size_us`,
/// and its `color` only when it requires a `color` (a value of `any` requires nothing). The
/// quantities of variants that become equal are added with overflow checks, and `max_line_qty` is
/// the largest of those sums.
///
/// The trace `errors` are these codes, sorted and without repeats:
/// - `context.invalid`: the context is not a record, or Cedar rejects it;
/// - `context.missing:<attr>`, `context.type:<attr>`, `context.extra:<attr>`: an attribute is
///   absent, has the wrong type (including a number that is not a safe integer, and a `now_ms`
///   for a clock outside years 0000 to 9999), or is not in the schema;
/// - `context.empty:variants`, `context.empty:categories`: the cart has no variant, or no
///   category or an empty category id;
/// - `context.quantities`: a quantity is below 1, the quantities are not keyed by the variants,
///   their largest is not `max_line_qty`, or a projected sum overflows;
/// - `entity.invalid:<field>`: the mandate field is missing or ill-typed, and
///   `entity.invalid:cedar` when Cedar rejects the entity;
/// - `request.invalid`: Cedar rejects the request;
/// - `policy.error:<id>`: Cedar could not evaluate policy `<id>`;
/// - `extras.invalid:<n>`: extra `n` does not compile, `extras.invalid:too_many` when there are
///   more than [`crate::MAX_EXTRAS`], and `extras.invalid:cedar` when Cedar rejects the policy set
///   (see [`evaluate_with_extras`]).
///
/// Each thread keeps the parts built from the last mandate and the last extras list it
/// evaluated, until it evaluates another one or exits.
pub fn evaluate(input: &EvalInput, meta: &EngineMeta) -> Trace {
    evaluate_with_extras(input, &[], meta)
}

/// Evaluates like [`evaluate`] with the policies [`crate::compile_extras`] builds from `extras`
/// added to the policy set. Each extra adds a field `extra.<n>` after the mandate fields, whose
/// `bound` is the extra's constant. An extra that does not compile denies with an
/// `extras.invalid` error, and no extra is then evaluated.
///
/// With any extras, the trace's `extras_hash` is the SHA-256 of the JCS form of `extras` in the
/// order given: the order is part of the input, since it sets the `extra.<n>` ids.
pub fn evaluate_with_extras(input: &EvalInput, extras: &[Extra], meta: &EngineMeta) -> Trace {
    let mandate = mandate_parts(input);
    let mut faults = Faults::default();
    let (context, projection) = project(input, &mandate, &mut faults);
    run(
        input,
        &mandate,
        context,
        Some(projection),
        faults,
        extras,
        meta,
    )
}

/// Evaluates `context`, a context in Cedar JSON form such as a trace records, in place of the
/// projection of `input.context`, to replay a recorded evaluation. A verifier replays a trace with
/// the trace's own `engine` meta and compares the whole result with it byte for byte, which
/// covers `decision` and `fired` at the least.
///
/// It applies the same fail-closed checks as [`evaluate`] to the context it is given, except
/// those on `input.context.quantities`, which a recorded context does not carry.
pub fn evaluate_context(input: &EvalInput, context: Value, meta: &EngineMeta) -> Trace {
    evaluate_context_with_extras(input, context, &[], meta)
}

/// Replays like [`evaluate_context`] with `extras` evaluated as [`evaluate_with_extras`] does.
pub fn evaluate_context_with_extras(
    input: &EvalInput,
    context: Value,
    extras: &[Extra],
    meta: &EngineMeta,
) -> Trace {
    let mandate = mandate_parts(input);
    run(
        input,
        &mandate,
        safe(context),
        None,
        Faults::default(),
        extras,
        meta,
    )
}

/// What one mandate and budget give every evaluation against them.
struct MandateParts {
    mandate_hash: [u8; 32],
    budget_left_minor: i64,
    /// The [`read`] members of the mandate, the only ones the parts are built from.
    mandate: Value,
    /// Whether the projection keeps each variant's `size` and `color`.
    keep: (bool, bool),
    /// The `Mandate` entity, or the error that keeps it from being built.
    resource: Result<Resource, String>,
}

struct Resource {
    uid: EntityUid,
    /// The entity store, `None` when Cedar rejects the entity against the schema.
    entities: Option<Entities>,
    /// The `bound` of each of [`base_fields`]: entity attributes in Cedar JSON form.
    bounds: Vec<Option<Value>>,
}

impl MandateParts {
    fn new(input: &EvalInput) -> Self {
        let [mid, nbf, exp, operator, currency, payment, checkout] =
            read(&input.mandate).map(Value::clone);
        let mandate = json!({
            "mid": mid,
            "nbf": nbf,
            "exp": exp,
            "agent": { "operator": operator },
            "payment": { "currency": currency, "constraints": payment },
            "checkout": { "constraints": checkout },
        });
        // An unreadable mandate denies anyway; its error is recorded when the entity is built.
        let keep = attributes(&mandate).map_or((true, true), |(size, color)| {
            (size.is_some(), color.is_some())
        });
        let resource = mandate_entity(&mandate, input.budget_left_minor)
            .map(|entity| {
                let attrs = entity
                    .to_json_value()
                    .ok()
                    .map(|e| safe(e["attrs"].clone()));
                Resource {
                    uid: entity.uid(),
                    bounds: base_fields()
                        .iter()
                        .map(|f| {
                            let (_, keys) = f.bindings?;
                            pick(attrs.as_ref()?, keys)
                        })
                        .collect(),
                    entities: Entities::from_entities([entity], Some(schema())).ok(),
                }
            })
            .map_err(|e| match e {
                PolicyError::Mandate { field, .. } => format!("entity.invalid:{field}"),
                PolicyError::Cedar(_) => "entity.invalid:cedar".to_owned(),
            });
        Self {
            mandate_hash: input.mandate_hash,
            budget_left_minor: input.budget_left_minor,
            mandate,
            keep,
            resource,
        }
    }

    fn matches(&self, input: &EvalInput) -> bool {
        self.mandate_hash == input.mandate_hash
            && self.budget_left_minor == input.budget_left_minor
            && read(&self.mandate)
                .into_iter()
                .zip(read(&input.mandate))
                .all(|(a, b)| same(a, b))
    }
}

/// The members of a mandate that [`mandate_entity`] and [`attributes`] read.
fn read(m: &Value) -> [&Value; 7] {
    [
        &m["mid"],
        &m["nbf"],
        &m["exp"],
        &m["agent"]["operator"],
        &m["payment"]["currency"],
        &m["payment"]["constraints"],
        &m["checkout"]["constraints"],
    ]
}

/// Whether two values are written the same, keys in the same order and numbers in the same
/// representation, so `0.0` and `-0.0` differ. Stricter than `==`, and cheaper.
///
/// Two mandates with the same keys in another order are rebuilt rather than reused, which costs
/// time but never changes the trace: nothing the entity builder reports depends on key order.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .zip(b)
                    .all(|((ka, va), (kb, vb))| ka == kb && same(va, vb))
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Number(a), Value::Number(b)) => {
            a.as_i64() == b.as_i64()
                && a.as_u64() == b.as_u64()
                && a.as_f64().map(f64::to_bits) == b.as_f64().map(f64::to_bits)
        }
        (a, b) => a == b,
    }
}

thread_local! {
    static MANDATE: Cell<Option<Rc<MandateParts>>> = const { Cell::new(None) };
    static EXTRAS: Cell<Option<Rc<ExtrasParts>>> = const { Cell::new(None) };
}

/// The parts of the last mandate evaluated on this thread, rebuilt when the mandate, its hash or
/// the budget differ.
fn mandate_parts(input: &EvalInput) -> Rc<MandateParts> {
    MANDATE.with(|slot| {
        let parts = slot
            .take()
            .filter(|p| p.matches(input))
            .unwrap_or_else(|| Rc::new(MandateParts::new(input)));
        slot.set(Some(Rc::clone(&parts)));
        parts
    })
}

/// A list of extras compiled into the policy set.
struct ExtrasParts {
    extras: Vec<Extra>,
    hash: String,
    /// The policy set with every extra added, or the error that keeps them all out.
    set: Result<PolicySet, String>,
}

impl ExtrasParts {
    fn new(extras: &[Extra]) -> Self {
        let list = safe(serde_json::to_value(extras).unwrap_or_default());
        let jcs = keelson_core::jcs(&list).unwrap_or_default();
        let set = match compile(extras) {
            Err(e) => Err(match e.reason {
                InvalidExtra::TooMany => "extras.invalid:too_many".to_owned(),
                _ => format!("extras.invalid:{}", e.index),
            }),
            Ok(compiled) => {
                let mut with = policies().clone();
                if compiled.into_iter().all(|(_, p, _)| with.add(p).is_ok()) {
                    Ok(with)
                } else {
                    Err("extras.invalid:cedar".to_owned())
                }
            }
        };
        Self {
            extras: extras.to_vec(),
            hash: hex("sha256:", &Sha256::digest(jcs.as_bytes())),
            set,
        }
    }
}

/// The last list of extras compiled on this thread, compiled again when the list differs.
fn extras_parts(extras: &[Extra]) -> Rc<ExtrasParts> {
    EXTRAS.with(|slot| {
        let parts = slot
            .take()
            .filter(|p| p.extras == extras)
            .unwrap_or_else(|| Rc::new(ExtrasParts::new(extras)));
        slot.set(Some(Rc::clone(&parts)));
        parts
    })
}

/// The projected values the Cedar context is built from, besides those of `input.context`.
struct Projection {
    variants: BTreeSet<Variant>,
    max_line_qty: i64,
    now_ms: Option<i64>,
}

/// The projection of `input.context` in Cedar JSON form, and the values Cedar reads.
fn project(input: &EvalInput, mandate: &MandateParts, faults: &mut Faults) -> (Value, Projection) {
    let c = &input.context;
    let (size, color) = mandate.keep;
    let projected = |v: &Variant| Variant {
        sku: v.sku.clone(),
        size: v.size.clone().filter(|_| size),
        color: v.color.clone().filter(|_| color),
    };
    let variants: BTreeSet<Variant> = c.variants.iter().map(projected).collect();

    let canonical = c.quantities.keys().eq(c.variants.iter())
        && c.quantities.values().all(|&q| q >= 1)
        && c.quantities.values().copied().max().unwrap_or(0) == c.max_line_qty;
    let mut sums: BTreeMap<(&str, Option<&str>, Option<&str>), i64> = BTreeMap::new();
    let mut overflow = false;
    for (v, &qty) in &c.quantities {
        let key = (
            v.sku.as_str(),
            v.size.as_deref().filter(|_| size),
            v.color.as_deref().filter(|_| color),
        );
        let sum = sums.entry(key).or_insert(0);
        match sum.checked_add(qty) {
            Some(s) => *sum = s,
            None => overflow = true,
        }
    }
    let max_line_qty = if canonical && !overflow {
        sums.into_values().max().unwrap_or(0)
    } else {
        faults.add(Some("quantity"), "context.quantities");
        c.max_line_qty
    };

    // A clock outside years 0000 to 9999 is recorded as `context.type:now_ms`.
    let now_ms = clock_ms(input.now);
    let mut context = Map::with_capacity(CONTEXT.len());
    let mut put = |key: &str, value: Value| context.insert(key.to_owned(), value);
    put("currency", Value::from(c.currency.as_str()));
    put("total_minor", long(c.total_minor));
    put("merchant", Value::from(c.merchant.as_str()));
    put(
        "categories",
        Value::Array(
            c.categories
                .iter()
                .map(|s| Value::from(s.as_str()))
                .collect(),
        ),
    );
    put(
        "variants",
        Value::Array(variants.iter().map(variant_json).collect()),
    );
    put("max_line_qty", long(max_line_qty));
    put("max_unit_minor", long(c.max_unit_minor));
    put("return_days", long(c.return_days));
    put("returns_free", Value::Bool(c.returns_free));
    put("now_ms", now_ms.map_or(Value::Null, Value::from));
    let projection = Projection {
        variants,
        max_line_qty,
        now_ms,
    };
    (Value::Object(context), projection)
}

/// A `Long` as [`safe`] writes it.
fn long(n: i64) -> Value {
    if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&n) {
        Value::from(n)
    } else {
        Value::String(n.to_string())
    }
}

/// A variant in Cedar JSON form; absent size and color are omitted.
fn variant_json(v: &Variant) -> Value {
    let mut record = Map::with_capacity(3);
    record.insert("sku".to_owned(), Value::from(v.sku.as_str()));
    if let Some(size) = &v.size {
        record.insert("size".to_owned(), Value::from(size.as_str()));
    }
    if let Some(color) = &v.color {
        record.insert("color".to_owned(), Value::from(color.as_str()));
    }
    Value::Object(record)
}

impl Projection {
    /// The Cedar context, built from the values the trace shows. It is only built once
    /// [`check_context`] has accepted those values, so it has the `checkout` context type.
    fn cedar(&self, c: &keelson_canon::Context) -> Option<Context> {
        let string = |s: &String| RestrictedExpression::new_string(s.clone());
        let pairs = [
            ("currency", string(&c.currency)),
            ("total_minor", RestrictedExpression::new_long(c.total_minor)),
            ("merchant", string(&c.merchant)),
            (
                "categories",
                RestrictedExpression::new_set(c.categories.iter().map(string)),
            ),
            (
                "variants",
                RestrictedExpression::new_set(self.variants.iter().map(variant_expr)),
            ),
            (
                "max_line_qty",
                RestrictedExpression::new_long(self.max_line_qty),
            ),
            (
                "max_unit_minor",
                RestrictedExpression::new_long(c.max_unit_minor),
            ),
            ("return_days", RestrictedExpression::new_long(c.return_days)),
            (
                "returns_free",
                RestrictedExpression::new_bool(c.returns_free),
            ),
            ("now_ms", RestrictedExpression::new_long(self.now_ms?)),
        ];
        Context::from_pairs(pairs.map(|(k, v)| (k.to_owned(), v))).ok()
    }
}

/// Checks the context against the `checkout` context type and rejects empty carts.
fn check_context(context: &Value, faults: &mut Faults) {
    let Some(record) = context.as_object() else {
        faults.add(None, "context.invalid");
        return;
    };
    for (attr, kind) in CONTEXT {
        match record.get(attr) {
            None => faults.add(None, format!("context.missing:{attr}")),
            Some(v) if !kind.accepts(v) => faults.add(None, format!("context.type:{attr}")),
            Some(_) => {}
        }
    }
    for key in record.keys() {
        if !CONTEXT.iter().any(|(attr, _)| attr == key) {
            faults.add(None, format!("context.extra:{key}"));
        }
    }
    if context["variants"].as_array().is_some_and(Vec::is_empty) {
        faults.add(None, "context.empty:variants");
    }
    if context["categories"]
        .as_array()
        .is_some_and(|c| c.is_empty() || c.iter().any(|c| c == ""))
    {
        faults.add(None, "context.empty:categories");
    }
}

/// A policy of the bundled set other than `base`, and what its field trace shows.
struct BaseField {
    id: String,
    field: String,
    color: String,
    /// The context and entity attributes from [`BINDINGS`].
    bindings: Option<(&'static [&'static str], &'static [&'static str])>,
}

/// The bundled policies other than `base`, in id order.
fn base_fields() -> &'static [BaseField] {
    static FIELDS: OnceLock<Vec<BaseField>> = OnceLock::new();
    FIELDS.get_or_init(|| {
        policy_texts()
            .keys()
            .filter(|id| *id != "base")
            .filter_map(|id| {
                let policy = policies().policy(&PolicyId::new(id))?;
                let annotation = |key| policy.annotation(key).unwrap_or_default().to_owned();
                Some(BaseField {
                    id: id.clone(),
                    field: annotation("field"),
                    color: annotation("color"),
                    bindings: BINDINGS
                        .iter()
                        .find(|(b, ..)| b == id)
                        .map(|&(_, ctx, attrs)| (ctx, attrs)),
                })
            })
            .collect()
    })
}

fn run(
    input: &EvalInput,
    mandate: &MandateParts,
    context: Value,
    projection: Option<Projection>,
    mut faults: Faults,
    extras: &[Extra],
    meta: &EngineMeta,
) -> Trace {
    let compiled = (!extras.is_empty()).then(|| extras_parts(extras));
    let (set, added) = match compiled.as_deref() {
        None => (policies(), &[][..]),
        Some(ExtrasParts { set: Ok(set), .. }) => (set, extras),
        Some(ExtrasParts { set: Err(code), .. }) => {
            faults.add(None, code.clone());
            (policies(), &[][..])
        }
    };

    let before = faults.errors.len();
    check_context(&context, &mut faults);
    let context_ok = faults.errors.len() == before;

    let resource = match &mandate.resource {
        Ok(r) => Some(r),
        Err(code) => {
            faults.add(None, code.clone());
            None
        }
    };
    let response = resource.filter(|_| context_ok).and_then(|resource| {
        let cedar_context = |action: &EntityUid| match &projection {
            Some(p) => p.cedar(&input.context),
            None => Context::from_json_value(context.clone(), Some((schema(), action))).ok(),
        };
        authorize(set, &input.agent, cedar_context, resource)
            .map_err(|code| faults.add(None, code))
            .ok()
    });

    let mut fired = Vec::new();
    let mut allowed = false;
    if let Some(r) = &response {
        allowed = r.decision() == cedar_policy::Decision::Allow;
        for id in r.diagnostics().reason() {
            if set.policy(id).map(|p| p.effect()) == Some(Effect::Forbid) {
                fired.push(id.to_string());
            }
        }
        for e in r.diagnostics().errors() {
            let AuthorizationError::PolicyEvaluationError(e) = e;
            let id = e.policy_id().as_ref();
            faults.add(Some(id), format!("policy.error:{id}"));
        }
    }
    fired.sort();
    faults.errors.sort();
    faults.errors.dedup();
    let decision = if allowed && fired.is_empty() && faults.errors.is_empty() {
        Decision::Allow
    } else {
        Decision::Deny
    };

    let pass = |id: &str| {
        response.is_some() && !fired.iter().any(|f| f == id) && !faults.policies.contains(id)
    };
    let mut fields = Vec::with_capacity(base_fields().len() + added.len());
    for (n, f) in base_fields().iter().enumerate() {
        let observed = f.bindings.and_then(|(keys, _)| {
            if f.id == "agent" {
                Some(json!({ "__entity": { "type": AGENT_TYPE, "id": input.agent } }))
            } else {
                pick(&context, keys)
            }
        });
        let bound = resource.and_then(|r| r.bounds.get(n).cloned().flatten());
        let evidence = input.evidence.get(&f.field).cloned().unwrap_or_default();
        let proven = evidence
            .iter()
            .any(|e| e.starts_with("ucp:") || e.starts_with("zktls:"));
        fields.push(FieldTrace {
            id: f.id.clone(),
            field: f.field.clone(),
            color: if proven {
                "green".to_owned()
            } else {
                f.color.clone()
            },
            pass: pass(&f.id),
            observed,
            bound,
            evidence,
        });
    }
    // Extras are always green, so evidence is not shown for them.
    for (n, extra) in added.iter().enumerate() {
        let (field, attr, _, literal) = extra.parts();
        let id = format!("extra.{n}");
        fields.push(FieldTrace {
            field: field.to_owned(),
            color: "green".to_owned(),
            pass: pass(&id),
            observed: pick(&context, &[attr]),
            bound: Some(literal),
            evidence: Vec::new(),
            id,
        });
    }

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
        extras_hash: compiled.as_ref().map(|p| p.hash.clone()),
        mandate_hash: hex("0x", &input.mandate_hash),
        cart_hash: hex("sha256:", &input.cart_hash),
        context,
        decision,
        fired,
        fields,
        errors: faults.errors,
        t_tee,
    }
}

fn action_uid() -> Option<&'static EntityUid> {
    static ACTION_UID: OnceLock<Option<EntityUid>> = OnceLock::new();
    ACTION_UID
        .get_or_init(|| EntityUid::from_str(ACTION).ok())
        .as_ref()
}

/// Builds the request and runs the authorizer.
fn authorize(
    policies: &PolicySet,
    agent: &str,
    context: impl FnOnce(&EntityUid) -> Option<Context>,
    resource: &Resource,
) -> Result<Response, &'static str> {
    let action = action_uid().ok_or("request.invalid")?;
    let principal = agent_entity_uid(agent).map_err(|_| "request.invalid")?;
    let context = context(action).ok_or("context.invalid")?;
    // The context already has the `checkout` context type, and the principal and resource are
    // built with the schema's entity types, so the request is not validated a second time.
    let request = Request::new(
        principal,
        action.clone(),
        resource.uid.clone(),
        context,
        None,
    )
    .map_err(|_| "request.invalid")?;
    let entities = resource.entities.as_ref().ok_or("entity.invalid:cedar")?;
    Ok(Authorizer::new().is_authorized(&request, policies, entities))
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

/// Writes every number that stands for a safe integer as that integer, and any other as its
/// decimal string, so the trace always has a JCS form. Cedar then rejects the string where it
/// expects a `Long`.
fn safe(value: Value) -> Value {
    match value {
        Value::Number(n) => match safe_int(&Value::Number(n.clone())) {
            Some(i) => Value::from(i),
            None => Value::String(n.to_string()),
        },
        Value::Array(items) => Value::Array(items.into_iter().map(safe).collect()),
        Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, safe(v))).collect()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::BINDINGS;
    use crate::{mandate_entity, policy_texts};

    #[test]
    fn every_policy_has_bindings() {
        let ids: BTreeSet<_> = policy_texts()
            .keys()
            .map(String::as_str)
            .filter(|id| *id != "base")
            .collect();
        let bound: BTreeSet<_> = BINDINGS.iter().map(|(id, ..)| *id).collect();
        assert_eq!(ids, bound);
        assert_eq!(BINDINGS.len(), bound.len());
    }

    #[test]
    fn bounds_cover_the_mandate_entity() {
        let m = serde_json::from_str(include_str!(
            "../../../packages/mandate/test/fixtures/demo-mandate.json"
        ))
        .unwrap();
        let entity = mandate_entity(&m, 10_000).unwrap().to_json_value().unwrap();
        let attrs: BTreeSet<_> = entity["attrs"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let bound: BTreeSet<_> = BINDINGS
            .iter()
            .flat_map(|(_, _, a)| a.iter().copied())
            .collect();
        assert_eq!(attrs, bound);
    }
}
