use std::collections::{BTreeSet, HashMap, HashSet};
use std::str::FromStr;

use cedar_policy::{Entity, EntityId, EntityTypeName, EntityUid, RestrictedExpression};
use keelson_canon::Variant;
use keelson_mandate::CATEGORY_IDS;
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, macros::format_description};

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
pub fn agent_uid(id: &str) -> Result<EntityUid, PolicyError> {
    uid("Keelson::Agent", id)
}

/// The agent a mandate authorizes: `<agent_registry>/<agent_id>`, its ERC-8004 identity.
///
/// `agent_id` must be a canonical decimal, so it never contains `/`. The id is then everything
/// after the last `/` and the registry everything before it, which makes the encoding injective
/// even when the registry contains `/`.
pub fn mandate_agent(m: &Value) -> Result<String, PolicyError> {
    let op = &m["agent"]["operator"];
    let registry = str_at(&op["agent_registry"], "agent.operator.agent_registry")?;
    let id = str_at(&op["agent_id"], "agent.operator.agent_id")?;
    let canonical = id == "0"
        || (!id.is_empty() && !id.starts_with('0') && id.bytes().all(|b| b.is_ascii_digit()));
    if !canonical {
        return Err(invalid(
            "agent.operator.agent_id",
            "expected a canonical decimal",
        ));
    }
    Ok(format!("{registry}/{id}"))
}

/// A Cedar `datetime` literal at millisecond precision, `YYYY-MM-DDThh:mm:ss.SSSZ`.
pub fn cedar_datetime(t: OffsetDateTime) -> Result<String, PolicyError> {
    t.to_offset(time::UtcOffset::UTC)
        .format(format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        ))
        .map_err(cedar)
}

fn datetime_ms(ms: i128) -> Result<RestrictedExpression, PolicyError> {
    let t = OffsetDateTime::from_unix_timestamp_nanos(ms * 1_000_000)
        .map_err(|e| invalid("datetime", &e.to_string()))?;
    Ok(RestrictedExpression::new_datetime(cedar_datetime(t)?))
}

/// The Cedar record for a variant; absent size and color are omitted, never null.
pub fn variant_expr(v: &Variant) -> RestrictedExpression {
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
        for (key, value) in must {
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
/// instant after `payment.execution_date.not_after`, which is inclusive.
fn expires_at_ms(m: &Value) -> Result<i128, PolicyError> {
    let exp = i128::from(int_at(&m["exp"], "exp")?) * 1000;
    let Some(date) = constraint(m, "payment", "payment.execution_date")? else {
        return Err(invalid("payment.execution_date", "required"));
    };
    let field = "payment.execution_date.not_after";
    let not_after = OffsetDateTime::parse(str_at(&date["not_after"], field)?, &Rfc3339)
        .map_err(|e| invalid(field, &e.to_string()))?;
    let not_after_ms = not_after.unix_timestamp_nanos().div_euclid(1_000_000);
    Ok(exp.min(not_after_ms + 1))
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
            RestrictedExpression::new_entity_uid(agent_uid(&mandate_agent(m)?)?),
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
            "not_before".to_owned(),
            datetime_ms(i128::from(int_at(&m["nbf"], "nbf")?) * 1000)?,
        ),
        ("expires_at".to_owned(), datetime_ms(expires_at_ms(m)?)?),
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
