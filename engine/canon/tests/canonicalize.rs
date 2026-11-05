use keelson_canon::{Cart, Deny, PayPalUnit, Variant, canonicalize};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Fixture {
    cart: Cart,
    unit: PayPalUnit,
}

fn fixture(json: &str) -> Fixture {
    serde_json::from_str(json).expect("fixture is valid")
}

fn demo() -> Fixture {
    fixture(include_str!("fixtures/demo-shoes.json"))
}

fn unit(value: &str, breakdown: Value) -> PayPalUnit {
    serde_json::from_value(json!({
        "amount": { "currency_code": "USD", "value": value, "breakdown": breakdown }
    }))
    .unwrap()
}

#[test]
fn demo_cart() {
    let f = demo();
    let ctx = canonicalize(&f.cart, &f.unit).unwrap();
    assert_eq!(ctx.total_minor, 9400);
    assert_eq!(ctx.currency, "USD");
    assert_eq!(ctx.categories.iter().collect::<Vec<_>>(), ["gpt:187"]);
    assert_eq!(
        ctx.variants.into_iter().collect::<Vec<_>>(),
        [Variant {
            sku: "RUN-100".into(),
            size: Some("10".into()),
            color: Some("black".into()),
        }]
    );
    assert_eq!(ctx.max_line_qty, 1);
    assert_eq!(ctx.return_days, 30);
}

#[test]
fn bundle_is_not_judged() {
    let f = fixture(include_str!("fixtures/bundle-340.json"));
    let ctx = canonicalize(&f.cart, &f.unit).unwrap();
    assert_eq!(ctx.total_minor, 34000);
    assert_eq!(ctx.categories.len(), 3);
    assert_eq!(ctx.variants.len(), 3);
    assert_eq!(ctx.max_line_qty, 3);
}

#[test]
fn breakdown_off_by_one_cent() {
    let f = fixture(include_str!("fixtures/breakdown-mismatch.json"));
    assert_eq!(
        canonicalize(&f.cart, &f.unit),
        Err(Deny::AmountBreakdownMismatch)
    );
}

#[test]
fn item_total_must_match_lines() {
    let f = demo();
    let u = unit(
        "95.00",
        json!({ "item_total": { "currency_code": "USD", "value": "95.00" } }),
    );
    assert_eq!(
        canonicalize(&f.cart, &u),
        Err(Deny::AmountBreakdownMismatch)
    );
}

#[test]
fn absent_shipping_counts_as_zero() {
    let f = demo();
    let with_zero = unit(
        "94.00",
        json!({
            "item_total": { "currency_code": "USD", "value": "94.00" },
            "shipping": { "currency_code": "USD", "value": "0.00" }
        }),
    );
    assert_eq!(
        canonicalize(&f.cart, &f.unit).unwrap(),
        canonicalize(&f.cart, &with_zero).unwrap()
    );
}

#[test]
fn every_breakdown_term_is_applied() {
    let f = demo();
    let u = unit(
        "100.00",
        json!({
            "item_total": { "currency_code": "USD", "value": "94.00" },
            "tax_total": { "currency_code": "USD", "value": "8.00" },
            "shipping": { "currency_code": "USD", "value": "5.00" },
            "handling": { "currency_code": "USD", "value": "2.00" },
            "insurance": { "currency_code": "USD", "value": "1.00" },
            "discount": { "currency_code": "USD", "value": "6.00" },
            "shipping_discount": { "currency_code": "USD", "value": "4.00" }
        }),
    );
    assert_eq!(canonicalize(&f.cart, &u).unwrap().total_minor, 10000);
}

#[test]
fn currency_mismatch() {
    let mut f = demo();
    f.cart.currency = "EUR".into();
    assert_eq!(canonicalize(&f.cart, &f.unit), Err(Deny::CurrencyMismatch));
}

#[test]
fn breakdown_currency_mismatch_is_rejected_on_parse() {
    let parsed = serde_json::from_value::<PayPalUnit>(json!({
        "amount": {
            "currency_code": "USD",
            "value": "94.00",
            "breakdown": { "item_total": { "currency_code": "EUR", "value": "94.00" } }
        }
    }));
    assert!(parsed.is_err());
}

#[test]
fn quantity_must_be_positive() {
    for qty in [0, -1] {
        let mut f = demo();
        f.cart.lines[0].qty = qty;
        assert_eq!(canonicalize(&f.cart, &f.unit), Err(Deny::InvalidQuantity));
    }
}

#[test]
fn negative_unit_price_is_invalid() {
    let mut f = demo();
    f.cart.lines[0].unit_minor = -1;
    assert_eq!(canonicalize(&f.cart, &f.unit), Err(Deny::InvalidAmount));
}

#[test]
fn empty_cart() {
    let mut f = demo();
    f.cart.lines.clear();
    assert_eq!(canonicalize(&f.cart, &f.unit), Err(Deny::EmptyCart));
}

#[test]
fn line_limit() {
    let mut f = demo();
    let line = f.cart.lines[0].clone();
    f.cart.lines = vec![line; 17];
    assert_eq!(canonicalize(&f.cart, &f.unit), Err(Deny::TooManyLines));
    f.cart.lines.pop();
    assert_ne!(canonicalize(&f.cart, &f.unit), Err(Deny::TooManyLines));
}

#[test]
fn overflow_is_checked() {
    let mut f = demo();
    f.cart.lines[0].unit_minor = i64::MAX;
    f.cart.lines[0].qty = 2;
    assert_eq!(canonicalize(&f.cart, &f.unit), Err(Deny::AmountOverflow));

    let mut f = demo();
    let mut line = f.cart.lines[0].clone();
    line.unit_minor = i64::MAX;
    f.cart.lines.push(line);
    assert_eq!(canonicalize(&f.cart, &f.unit), Err(Deny::AmountOverflow));
}

#[test]
fn amount_beyond_i64_overflows() {
    let f = demo();
    let u = unit("99999999999999999999999.00", json!({}));
    assert_eq!(canonicalize(&f.cart, &u), Err(Deny::AmountOverflow));
}

#[test]
fn deny_reasons_are_snake_case() {
    assert_eq!(
        serde_json::to_value(Deny::AmountBreakdownMismatch).unwrap(),
        "amount_breakdown_mismatch"
    );
    assert_eq!(serde_json::to_value(Deny::EmptyCart).unwrap(), "empty_cart");
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    input: Value,
    expected: String,
}

#[test]
fn money_vectors_parse_like_typescript() {
    let vectors: Vec<Vector> = serde_json::from_str(include_str!(
        "../../../packages/core/test/vectors/money.json"
    ))
    .unwrap();
    let mut checked = 0;
    for v in vectors
        .iter()
        .filter(|v| v.input["op"] == "fromPayPalValue")
    {
        let currency = v.input["currency"].as_str().unwrap();
        let value = v.input["value"].as_str().unwrap();
        let expected = v.expected.parse::<i64>().ok().filter(|m| *m >= 0);
        let cart = Cart {
            merchant: "m".into(),
            currency: currency.into(),
            return_days: 0,
            lines: vec![keelson_canon::CartLine {
                sku: "s".into(),
                size: None,
                color: None,
                category: "c".into(),
                qty: 1,
                unit_minor: expected.unwrap_or(0),
            }],
        };
        let u: PayPalUnit = serde_json::from_value(json!({
            "amount": {
                "currency_code": currency,
                "value": value,
                "breakdown": { "item_total": { "currency_code": currency, "value": value } }
            }
        }))
        .unwrap();
        match expected {
            Some(minor) => assert_eq!(
                canonicalize(&cart, &u).map(|c| c.total_minor),
                Ok(minor),
                "{}",
                v.name
            ),
            None => assert!(canonicalize(&cart, &u).is_err(), "{}", v.name),
        }
        checked += 1;
    }
    assert!(checked > 0);
}
