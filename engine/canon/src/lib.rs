//! Turns a proposed cart and its PayPal purchase unit into the Cedar policy context.
//!
//! All arithmetic is checked `i64` in minor units.

mod money;
mod types;

pub use types::{Breakdown, Cart, CartLine, Context, Deny, PayPalUnit, Variant};

use std::collections::BTreeSet;

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
    let part = |v: &Option<String>| match v {
        Some(v) => money::parse(currency, v),
        None => Ok(0),
    };
    let item_total = part(&b.item_total)?;
    let total = money::parse(currency, &unit.value)?;
    let charges = [&b.tax_total, &b.shipping, &b.handling, &b.insurance];
    let credits = [&b.discount, &b.shipping_discount];
    let mut expected = item_total;
    for v in charges {
        expected = expected.checked_add(part(v)?).ok_or(Deny::AmountOverflow)?;
    }
    for v in credits {
        expected = expected.checked_sub(part(v)?).ok_or(Deny::AmountOverflow)?;
    }
    if items != item_total || expected != total {
        return Err(Deny::AmountBreakdownMismatch);
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
        variants: cart
            .lines
            .iter()
            .map(|l| Variant {
                sku: l.sku.clone(),
                size: l.size.clone(),
                color: l.color.clone(),
            })
            .collect(),
        max_line_qty: cart.lines.iter().map(|l| l.qty).max().unwrap_or(0),
        return_days: cart.return_days,
    })
}
