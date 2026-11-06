//! Property tests over whole carts and purchase units, including strings no PayPal response would
//! contain. The arithmetic core is also proved with Kani in `src/proofs.rs`.

use keelson_canon::{Amount, Breakdown, Cart, CartLine, Context, Deny, PayPalUnit, canonicalize};
use proptest::prelude::*;
use std::collections::BTreeMap;

fn int() -> impl Strategy<Value = i64> {
    prop_oneof![
        any::<i64>(),
        0..1_000i64,
        Just(i64::MAX),
        Just(i64::MIN),
        Just(0),
        Just(1),
    ]
}

fn currency() -> impl Strategy<Value = String> {
    prop_oneof![
        Just("USD".to_owned()),
        Just("EUR".to_owned()),
        Just("JPY".to_owned()),
        ".{0,4}",
    ]
}

/// Decimal strings around and past the `i64` range, malformed numbers, and arbitrary text.
fn value() -> impl Strategy<Value = String> {
    prop_oneof![
        any::<i64>().prop_map(|m| format!("{}.{:02}", m / 100, (m % 100).abs())),
        (0..10u128.pow(24)).prop_map(|m| format!("{}.{:02}", m / 100, m % 100)),
        any::<u64>().prop_map(|m| m.to_string()),
        "[-0-9.]{0,24}",
        ".{0,12}",
    ]
}

fn amount() -> impl Strategy<Value = Option<Amount>> {
    proptest::option::of(
        (currency(), value()).prop_map(|(currency_code, value)| Amount {
            currency_code,
            value,
        }),
    )
}

fn line() -> impl Strategy<Value = CartLine> {
    (
        ".{0,6}",
        proptest::option::of(".{0,3}"),
        proptest::option::of(".{0,3}"),
        ".{0,6}",
        int(),
        int(),
    )
        .prop_map(|(sku, size, color, category, qty, unit_minor)| CartLine {
            sku,
            size,
            color,
            category,
            qty,
            unit_minor,
        })
}

fn cart() -> impl Strategy<Value = Cart> {
    (
        ".{0,8}",
        currency(),
        proptest::collection::vec(line(), 0..=20),
        int(),
    )
        .prop_map(|(merchant, currency, lines, return_days)| Cart {
            merchant,
            currency,
            lines,
            return_days,
        })
}

fn unit() -> impl Strategy<Value = PayPalUnit> {
    (
        currency(),
        value(),
        [
            amount(),
            amount(),
            amount(),
            amount(),
            amount(),
            amount(),
            amount(),
        ],
    )
        .prop_map(
            |(currency, value, [it, tax, ship, hand, ins, disc, ship_disc])| PayPalUnit {
                currency,
                value,
                breakdown: Breakdown {
                    item_total: it,
                    tax_total: tax,
                    shipping: ship,
                    handling: hand,
                    insurance: ins,
                    discount: disc,
                    shipping_discount: ship_disc,
                },
            },
        )
}

fn minor(currency: &str, a: &Option<Amount>) -> i128 {
    a.as_ref().map_or(0, |a| {
        keelson_core::from_paypal_value(currency, &a.value)
            .unwrap()
            .minor
    })
}

/// Σ lines plus breakdown adjustments, in `i128`.
fn expected_total(cart: &Cart, unit: &PayPalUnit) -> i128 {
    let b = &unit.breakdown;
    let c = &unit.currency;
    let lines: i128 = cart
        .lines
        .iter()
        .map(|l| l.qty as i128 * l.unit_minor as i128)
        .sum();
    lines
        + minor(c, &b.tax_total)
        + minor(c, &b.shipping)
        + minor(c, &b.handling)
        + minor(c, &b.insurance)
        - minor(c, &b.discount)
        - minor(c, &b.shipping_discount)
}

fn check(
    cart: &Cart,
    unit: &PayPalUnit,
    result: &Result<Context, Deny>,
) -> Result<(), TestCaseError> {
    if let Ok(ctx) = result {
        prop_assert_eq!(ctx.total_minor as i128, expected_total(cart, unit));
        let mut per_variant = BTreeMap::new();
        for l in &cart.lines {
            *per_variant
                .entry((&l.sku, &l.size, &l.color))
                .or_insert(0i128) += l.qty as i128;
        }
        prop_assert_eq!(ctx.variants.len(), per_variant.len());
        prop_assert_eq!(
            ctx.max_line_qty as i128,
            per_variant.into_values().max().unwrap()
        );
    }
    Ok(())
}

fn usd(minor: i64) -> Option<Amount> {
    Some(Amount {
        currency_code: "USD".to_owned(),
        value: format!("{}.{:02}", minor / 100, minor % 100),
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(4096))]

    #[test]
    fn canonicalize_never_panics(cart in cart(), unit in unit()) {
        let result = canonicalize(&cart, &unit);
        check(&cart, &unit, &result)?;
    }

    #[test]
    fn canonicalize_total_matches_lines(
        lines in proptest::collection::vec((1..50i64, 0..100_000i64), 1..=16),
        additions in [0..10_000i64, 0..10_000i64, 0..10_000i64, 0..10_000i64],
        deductions in [0..1_000i64, 0..1_000i64],
    ) {
        let items: i64 = lines.iter().map(|(q, u)| q * u).sum();
        let total = items + additions.iter().sum::<i64>() - deductions.iter().sum::<i64>();
        prop_assume!(total >= 0);
        let cart = Cart {
            merchant: "m".to_owned(),
            currency: "USD".to_owned(),
            lines: lines
                .iter()
                .enumerate()
                .map(|(i, &(qty, unit_minor))| CartLine {
                    sku: format!("sku-{}", i % 3),
                    size: None,
                    color: None,
                    category: "c".to_owned(),
                    qty,
                    unit_minor,
                })
                .collect(),
            return_days: 30,
        };
        let unit = PayPalUnit {
            currency: "USD".to_owned(),
            value: usd(total).unwrap().value,
            breakdown: Breakdown {
                item_total: usd(items),
                tax_total: usd(additions[0]),
                shipping: usd(additions[1]),
                handling: usd(additions[2]),
                insurance: usd(additions[3]),
                discount: usd(deductions[0]),
                shipping_discount: usd(deductions[1]),
            },
        };
        let result = canonicalize(&cart, &unit);
        prop_assert!(result.is_ok());
        check(&cart, &unit, &result)?;
    }
}
