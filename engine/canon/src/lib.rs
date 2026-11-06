//! Turns a proposed cart and its PayPal purchase unit into the Cedar policy context.
//!
//! All arithmetic is checked `i64` in minor units.

mod money;
mod types;

pub use types::{Amount, Breakdown, Cart, CartLine, Context, Deny, PayPalUnit, Variant};

use std::collections::{BTreeMap, BTreeSet};

const MAX_LINES: usize = 16;

/// Verifies that the cart reconciles with the purchase unit and derives the policy context.
pub fn canonicalize(cart: &Cart, unit: &PayPalUnit) -> Result<Context, Deny> {
    if cart.lines.is_empty() {
        return Err(Deny::EmptyCart);
    }
    if cart.lines.len() > MAX_LINES {
        return Err(Deny::TooManyLines);
    }
    if cart.currency != unit.currency {
        return Err(Deny::CurrencyMismatch);
    }
    let currency = &unit.currency;

    let mut items = 0i64;
    for line in &cart.lines {
        if line.qty < 1 {
            return Err(Deny::InvalidQuantity);
        }
        if line.unit_minor < 0 {
            return Err(Deny::InvalidAmount);
        }
        let extended = line
            .qty
            .checked_mul(line.unit_minor)
            .ok_or(Deny::AmountOverflow)?;
        items = items.checked_add(extended).ok_or(Deny::AmountOverflow)?;
    }

    let b = &unit.breakdown;
    let entries = [
        &b.item_total,
        &b.tax_total,
        &b.shipping,
        &b.handling,
        &b.insurance,
        &b.discount,
        &b.shipping_discount,
    ];
    if entries
        .into_iter()
        .flatten()
        .any(|a| a.currency_code != *currency)
    {
        return Err(Deny::CurrencyMismatch);
    }
    let part = |a: &Option<Amount>| match a {
        Some(a) => money::parse(currency, &a.value),
        None => Ok(0),
    };
    let item_total = match &b.item_total {
        Some(_) => part(&b.item_total)?,
        None => return Err(Deny::InvalidAmount),
    };
    let total = money::parse(currency, &unit.value)?;
    let mut expected = item_total;
    for v in [&b.tax_total, &b.shipping, &b.handling, &b.insurance] {
        expected = expected.checked_add(part(v)?).ok_or(Deny::AmountOverflow)?;
    }
    for v in [&b.discount, &b.shipping_discount] {
        expected = expected.checked_sub(part(v)?).ok_or(Deny::AmountOverflow)?;
    }
    if items != item_total || expected != total {
        return Err(Deny::AmountBreakdownMismatch);
    }

    let mut per_variant: BTreeMap<Variant, i64> = BTreeMap::new();
    for line in &cart.lines {
        let variant = Variant {
            sku: line.sku.clone(),
            size: line.size.clone(),
            color: line.color.clone(),
        };
        let qty = per_variant.entry(variant).or_insert(0);
        *qty = qty.checked_add(line.qty).ok_or(Deny::AmountOverflow)?;
    }

    Ok(Context {
        currency: currency.clone(),
        total_minor: total,
        merchant: cart.merchant.clone(),
        categories: cart
            .lines
            .iter()
            .map(|l| l.category.clone())
            .collect::<BTreeSet<_>>(),
        max_line_qty: per_variant.values().copied().max().unwrap_or(0),
        variants: per_variant.into_keys().collect(),
        return_days: cart.return_days,
    })
}
