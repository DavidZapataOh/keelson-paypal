//! Turns a proposed cart and its PayPal purchase unit into the Cedar policy context.
//!
//! All arithmetic is checked `i64` in minor units.

mod money;
#[cfg(kani)]
mod proofs;
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

    let items = sum_minor(cart.lines.iter().map(|l| (l.qty, l.unit_minor)))?;

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
    let additions = [
        part(&b.tax_total)?,
        part(&b.shipping)?,
        part(&b.handling)?,
        part(&b.insurance)?,
    ];
    let deductions = [part(&b.discount)?, part(&b.shipping_discount)?];
    let expected = breakdown_total(item_total, additions, deductions)?;
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

/// Sums `qty × unit_minor` over `(qty, unit_minor)` pairs, rejecting quantities below one and
/// negative prices.
fn sum_minor(lines: impl IntoIterator<Item = (i64, i64)>) -> Result<i64, Deny> {
    let mut items = 0i64;
    for (qty, unit_minor) in lines {
        if qty < 1 {
            return Err(Deny::InvalidQuantity);
        }
        if unit_minor < 0 {
            return Err(Deny::InvalidAmount);
        }
        let extended = qty.checked_mul(unit_minor).ok_or(Deny::AmountOverflow)?;
        items = items.checked_add(extended).ok_or(Deny::AmountOverflow)?;
    }
    Ok(items)
}

/// The amount a breakdown adds up to: the item total plus additions, minus deductions.
fn breakdown_total(
    item_total: i64,
    additions: [i64; 4],
    deductions: [i64; 2],
) -> Result<i64, Deny> {
    let mut total = item_total;
    for a in additions {
        total = total.checked_add(a).ok_or(Deny::AmountOverflow)?;
    }
    for d in deductions {
        total = total.checked_sub(d).ok_or(Deny::AmountOverflow)?;
    }
    Ok(total)
}
