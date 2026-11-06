use std::collections::{BTreeSet, HashMap, HashSet};
use std::str::FromStr;
use std::sync::OnceLock;

use cedar_policy::{Entity, EntityId, EntityTypeName, EntityUid, RestrictedExpression};
use keelson_canon::Variant;
use keelson_mandate::CATEGORY_IDS;
use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::{PolicyError, safe_int};

/// A `keelson.attributes` value that leaves the attribute unconstrained.
const ANY: &str = "any";

fn invalid(field: &str, reason: &str) -> PolicyError {
    PolicyError::Mandate {
        field: field.to_owned(),
        reason: reason.to_owned(),
    }
}

fn cedar(e: impl std::fmt::Display) -> PolicyError {
    PolicyError::Cedar(e.to_string())
}

fn str_at<'a>(v: &'a Value, field: &str) -> Result<&'a str, PolicyError> {
    v.as_str().ok_or_else(|| invalid(field, "expected string"))
}

fn int_at(v: &Value, field: &str) -> Result<i64, PolicyError> {
    safe_int(v).ok_or_else(|| invalid(field, "expected integer"))
}

fn array_at<'a>(v: &'a Value, field: &str) -> Result<&'a [Value], PolicyError> {
    v.as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| invalid(field, "expected array"))
}

/// The constraint of type `ty`, if any; a repeated type is an error rather than a first match.
fn constraint<'a>(m: &'a Value, group: &str, ty: &str) -> Result<Option<&'a Value>, PolicyError> {
    let field = format!("{group}.constraints");
    let mut found = array_at(&m[group]["constraints"], &field)?
        .iter()
        .filter(|c| c["type"].as_str() == Some(ty));
    let first = found.next();
    if found.next().is_some() {
        return Err(invalid(&field, &format!("more than one {ty}")));
    }
    Ok(first)
}

fn uid(ty: &str, id: &str) -> Result<EntityUid, PolicyError> {
    Ok(EntityUid::from_type_name_and_id(
        EntityTypeName::from_str(ty).map_err(cedar)?,
        EntityId::new(id),
    ))
}

/// The `Keelson::Agent` entity uid for an agent id.
pub(crate) fn agent_entity_uid(id: &str) -> Result<EntityUid, PolicyError> {
    static AGENT: OnceLock<Result<EntityTypeName, PolicyError>> = OnceLock::new();
    let ty = AGENT
        .get_or_init(|| EntityTypeName::from_str("Keelson::Agent").map_err(cedar))
        .clone()?;
    Ok(EntityUid::from_type_name_and_id(ty, EntityId::new(id)))
}

/// An agent's uid, `<registry>/<agent_id>`, its ERC-8004 identity; `None` unless `agent_id` is a
/// canonical decimal.
///
/// `agent_id` never contains `/`, so the id is everything after the last `/` and the registry
/// everything before it, which makes the encoding injective even when the registry contains `/`.
///
/// [`EvalInput::agent`](crate::EvalInput::agent) is this uid for the authenticated requester.
pub fn agent_uid(registry: &str, agent_id: &str) -> Option<String> {
    let canonical = agent_id == "0"
        || (!agent_id.is_empty()
            && !agent_id.starts_with('0')
            && agent_id.bytes().all(|b| b.is_ascii_digit()));
    canonical.then(|| format!("{registry}/{agent_id}"))
}

/// The [`agent_uid`] of the agent a mandate authorizes, which the `agent` policy compares with
/// the requester. It is never the requester itself: that comes from the request's authentication.
pub fn mandate_agent(m: &Value) -> Result<String, PolicyError> {
    let op = &m["agent"]["operator"];
    let registry = str_at(&op["agent_registry"], "agent.operator.agent_registry")?;
    let id = str_at(&op["agent_id"], "agent.operator.agent_id")?;
    agent_uid(registry, id)
        .ok_or_else(|| invalid("agent.operator.agent_id", "expected a canonical decimal"))
}

/// The first and last instants of years 0000 to 9999 in Unix milliseconds, the instants the
/// window and the clock may take.
const FIRST_MS: i64 = -62_167_219_200_000;
const LAST_MS: i64 = 253_402_300_799_999;

/// `ms` when it lies within years 0000 to 9999.
pub(crate) fn epoch_ms(ms: i128) -> Option<i64> {
    i64::try_from(ms)
        .ok()
        .filter(|ms| (FIRST_MS..=LAST_MS).contains(ms))
}

/// The clock in Unix milliseconds, rounded down, when it lies within years 0000 to 9999.
pub(crate) fn clock_ms(t: OffsetDateTime) -> Option<i64> {
    epoch_ms(t.unix_timestamp_nanos().div_euclid(1_000_000))
}

/// A window bound read from mandate `field`.
fn window_ms(ms: i128, field: &str) -> Result<RestrictedExpression, PolicyError> {
    let ms = epoch_ms(ms).ok_or_else(|| invalid(field, "outside years 0000 to 9999"))?;
    Ok(RestrictedExpression::new_long(ms))
}

/// The Cedar record for a variant; absent size and color are omitted, never null.
pub(crate) fn variant_expr(v: &Variant) -> RestrictedExpression {
    let fields = [
        ("sku", Some(&v.sku)),
        ("size", v.size.as_ref()),
        ("color", v.color.as_ref()),
    ]
    .into_iter()
    .filter_map(|(k, v)| Some((k.to_owned(), RestrictedExpression::new_string(v?.clone()))));
    RestrictedExpression::new_record(fields).expect("variant keys are distinct")
}

fn strings(values: impl IntoIterator<Item = String>) -> RestrictedExpression {
    RestrictedExpression::new_set(values.into_iter().map(RestrictedExpression::new_string))
}

/// The size and color the mandate's `keelson.attributes` require; `None` when an attribute is
/// absent or `any`, which leaves it unconstrained.
pub(crate) fn attributes(m: &Value) -> Result<(Option<String>, Option<String>), PolicyError> {
    let mut size = None;
    let mut color = None;
    if let Some(attrs) = constraint(m, "checkout", "keelson.attributes")? {
        let must = attrs["must"]
            .as_object()
            .ok_or_else(|| invalid("keelson.attributes.must", "expected record"))?;
        // In key order, so the first unsupported key does not depend on how the JSON was written.
        let mut keys: Vec<&String> = must.keys().collect();
        keys.sort_unstable();
        for key in keys {
            let value = &must[key];
            let field = format!("keelson.attributes.must.{key}");
            let value = str_at(value, &field)?;
            let slot = match key.as_str() {
                "size_us" => &mut size,
                "color" => &mut color,
                _ => return Err(invalid(&field, "unsupported attribute")),
            };
            *slot = (value != ANY).then(|| value.to_owned());
        }
    }
    Ok((size, color))
}

/// The allowed variants and the quantity bound.
///
/// Variants are each acceptable item of each line, with the `keelson.attributes` size (`size_us`)
/// and color unless they are `any`. The quantity bound is the smallest line quantity: the policy
/// set has no arithmetic and the entity holds a single bound, so Cedar cannot tie a quantity to
/// a variant, and the smallest quantity is the bound that never allows more than any line does.
/// It is 0, which denies every cart, when the mandate has no lines.
fn variants(m: &Value) -> Result<(BTreeSet<Variant>, i64), PolicyError> {
    let (size, color) = attributes(m)?;
    let mut out = BTreeSet::new();
    let mut max_qty: Option<i64> = None;
    if let Some(lines) = constraint(m, "checkout", "checkout.line_items")? {
        for line in array_at(&lines["items"], "checkout.line_items.items")? {
            let qty = int_at(&line["quantity"], "checkout.line_items.quantity")?;
            max_qty = Some(max_qty.map_or(qty, |q| q.min(qty)));
            let items = array_at(
                &line["acceptable_items"],
                "checkout.line_items.acceptable_items",
            )?;
            for item in items {
                out.insert(Variant {
                    sku: str_at(&item["id"], "checkout.line_items.acceptable_items.id")?.to_owned(),
                    size: size.clone(),
                    color: color.clone(),
                });
            }
        }
    }
    Ok((out, max_qty.unwrap_or(0)))
}

/// `keelson.category` allow minus deny; every category when the mandate has no category
/// constraint.
fn categories(m: &Value) -> Result<BTreeSet<String>, PolicyError> {
    let Some(c) = constraint(m, "checkout", "keelson.category")? else {
        return Ok(CATEGORY_IDS.iter().map(|&c| c.to_owned()).collect());
    };
    let ids = |key: &str| -> Result<BTreeSet<String>, PolicyError> {
        let field = format!("keelson.category.{key}");
        array_at(&c[key], &field)?
            .iter()
            .map(|v| str_at(v, &field).map(str::to_owned))
            .collect()
    };
    let deny = ids("deny")?;
    Ok(ids("allow")?
        .into_iter()
        .filter(|c| !deny.contains(c))
        .collect())
}

/// The exclusive end of the purchase window in Unix milliseconds: the earlier of `exp` and the
/// instant after `payment.execution_date.not_after`, which is inclusive, and the field it comes
/// from (`exp` when both are equal).
fn expires_at_ms(m: &Value) -> Result<(i128, &'static str), PolicyError> {
    let exp = i128::from(int_at(&m["exp"], "exp")?) * 1000;
    let Some(date) = constraint(m, "payment", "payment.execution_date")? else {
        return Err(invalid("payment.execution_date", "required"));
    };
    let field = "payment.execution_date.not_after";
    let not_after = OffsetDateTime::parse(str_at(&date["not_after"], field)?, &Rfc3339)
        .map_err(|e| invalid(field, &e.to_string()))?;
    let end = not_after.unix_timestamp_nanos().div_euclid(1_000_000) + 1;
    Ok(if exp <= end {
        (exp, "exp")
    } else {
        (end, field)
    })
}

/// Builds the `Keelson::Mandate` entity from a decoded mandate and the budget left on it.
///
/// `budget_left_minor` is capped at `payment.budget.max`, so a wrong counter can never raise the
/// budget above what the user signed.
pub fn mandate_entity(m: &Value, budget_left_minor: i64) -> Result<Entity, PolicyError> {
    let mid = str_at(&m["mid"], "mid")?;
    let Some(range) = constraint(m, "payment", "payment.amount_range")? else {
        return Err(invalid("payment.amount_range", "required"));
    };
    let Some(budget) = constraint(m, "payment", "payment.budget")? else {
        return Err(invalid("payment.budget", "required"));
    };
    let budget_left_minor = budget_left_minor.min(int_at(&budget["max"], "payment.budget.max")?);
    let Some(allowed) = constraint(m, "checkout", "checkout.allowed_merchants")? else {
        return Err(invalid("checkout.allowed_merchants", "required"));
    };
    let merchants = array_at(&allowed["allowed"], "checkout.allowed_merchants.allowed")?
        .iter()
        .map(|x| str_at(&x["id"], "checkout.allowed_merchants.allowed.id").map(str::to_owned))
        .collect::<Result<BTreeSet<_>, _>>()?;
    let (min_return_days, returns_free_required) =
        match constraint(m, "checkout", "keelson.returns")? {
            Some(r) => (
                int_at(&r["min_days"], "keelson.returns.min_days")?,
                r["free"]
                    .as_bool()
                    .ok_or_else(|| invalid("keelson.returns.free", "expected boolean"))?,
            ),
            None => (0, false),
        };
    let (variants, max_qty_per_line) = variants(m)?;

    let attrs = HashMap::from([
        (
            "agent".to_owned(),
            RestrictedExpression::new_entity_uid(agent_entity_uid(&mandate_agent(m)?)?),
        ),
        (
            "currency".to_owned(),
            RestrictedExpression::new_string(
                str_at(&m["payment"]["currency"], "payment.currency")?.to_owned(),
            ),
        ),
        (
            "max_total_minor".to_owned(),
            RestrictedExpression::new_long(int_at(&range["max"], "payment.amount_range.max")?),
        ),
        (
            "budget_left_minor".to_owned(),
            RestrictedExpression::new_long(budget_left_minor),
        ),
        ("merchants".to_owned(), strings(merchants)),
        ("categories".to_owned(), strings(categories(m)?)),
        (
            "variants".to_owned(),
            RestrictedExpression::new_set(variants.iter().map(variant_expr)),
        ),
        (
            "max_qty_per_line".to_owned(),
            RestrictedExpression::new_long(max_qty_per_line),
        ),
        (
            "not_before_ms".to_owned(),
            window_ms(i128::from(int_at(&m["nbf"], "nbf")?) * 1000, "nbf")?,
        ),
        ("expires_at_ms".to_owned(), {
            let (ms, field) = expires_at_ms(m)?;
            window_ms(ms, field)?
        }),
        (
            "min_return_days".to_owned(),
            RestrictedExpression::new_long(min_return_days),
        ),
        (
            "returns_free_required".to_owned(),
            RestrictedExpression::new_bool(returns_free_required),
        ),
    ]);
    Entity::new(uid("Keelson::Mandate", mid)?, attrs, HashSet::new()).map_err(cedar)
}
