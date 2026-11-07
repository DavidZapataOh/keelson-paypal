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

impl Fixture {
    fn cart_json(&self) -> Value {
        let raw: Value = serde_json::from_str(include_str!("fixtures/demo-shoes.json")).unwrap();
        raw["cart"].clone()
    }
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
            sku: "sku-trail-10".into(),
            size: Some("10".into()),
            color: Some("black".into()),
        }]
    );
    assert_eq!(ctx.max_line_qty, 1);
    assert_eq!(ctx.max_unit_minor, 9400);
    assert_eq!(ctx.quantities.values().copied().collect::<Vec<_>>(), [1]);
    assert_eq!(ctx.return_days, 30);
    assert!(ctx.returns_free);
}

#[test]
fn bundle_is_not_judged() {
    let f = fixture(include_str!("fixtures/bundle-340.json"));
    let ctx = canonicalize(&f.cart, &f.unit).unwrap();
    assert_eq!(ctx.total_minor, 34000);
    assert_eq!(ctx.categories.len(), 3);
    assert_eq!(ctx.variants.len(), 3);
    assert_eq!(ctx.max_line_qty, 3);
    assert_eq!(ctx.max_unit_minor, 10700);
    assert_eq!(
        ctx.quantities.values().copied().collect::<Vec<_>>(),
        [1, 3, 2]
    );
    assert!(ctx.quantities.keys().eq(ctx.variants.iter()));
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
fn breakdown_currency_mismatch_per_entry() {
    let f = demo();
    for kind in [
        "item_total",
        "tax_total",
        "shipping",
        "handling",
        "insurance",
        "discount",
        "shipping_discount",
    ] {
        let mut breakdown = json!({ "item_total": { "currency_code": "USD", "value": "94.00" } });
        breakdown[kind] = json!({ "currency_code": "EUR", "value": "94.00" });
        let u = unit("94.00", breakdown);
        assert_eq!(
            canonicalize(&f.cart, &u),
            Err(Deny::CurrencyMismatch),
            "{kind}"
        );
    }
}

#[test]
fn missing_item_total_is_invalid() {
    let f = demo();
    let u = unit(
        "5.00",
        json!({ "shipping": { "currency_code": "USD", "value": "5.00" } }),
    );
    assert_eq!(canonicalize(&f.cart, &u), Err(Deny::InvalidAmount));
}

#[test]
fn discount_beyond_subtotal_is_a_mismatch() {
    let f = demo();
    let u = unit(
        "0.00",
        json!({
            "item_total": { "currency_code": "USD", "value": "94.00" },
            "discount": { "currency_code": "USD", "value": "100.00" }
        }),
    );
    assert_eq!(
        canonicalize(&f.cart, &u),
        Err(Deny::AmountBreakdownMismatch)
    );
}

#[test]
fn breakdown_arithmetic_overflows_are_checked() {
    let mut f = demo();
    f.cart.lines[0].unit_minor = i64::MAX;
    let max = "92233720368547758.07";
    let add = unit(
        max,
        json!({
            "item_total": { "currency_code": "USD", "value": max },
            "tax_total": { "currency_code": "USD", "value": "0.01" }
        }),
    );
    assert_eq!(canonicalize(&f.cart, &add), Err(Deny::AmountOverflow));
    f.cart.lines[0].unit_minor = 0;
    let sub = unit(
        "0.00",
        json!({
            "item_total": { "currency_code": "USD", "value": "0.00" },
            "discount": { "currency_code": "USD", "value": max },
            "shipping_discount": { "currency_code": "USD", "value": max }
        }),
    );
    assert_eq!(canonicalize(&f.cart, &sub), Err(Deny::AmountOverflow));
}

#[test]
fn unknown_fields_are_parse_errors() {
    let mut cart = demo().cart_json();
    cart["lines"][0]["currency"] = json!("EUR");
    assert!(serde_json::from_value::<Cart>(cart).is_err());
    let mut cart = demo().cart_json();
    cart["extra"] = json!(1);
    assert!(serde_json::from_value::<Cart>(cart).is_err());
    let bad_amount = json!({ "amount": { "currency_code": "USD", "value": "1.00", "extra": 1 } });
    assert!(serde_json::from_value::<PayPalUnit>(bad_amount).is_err());
    let bad_part = json!({ "amount": { "currency_code": "USD", "value": "1.00",
        "breakdown": { "item_total": { "currency_code": "USD", "value": "1.00" }, "extra": 1 } } });
    assert!(serde_json::from_value::<PayPalUnit>(bad_part).is_err());
}

#[test]
fn context_json_has_no_nulls() {
    let f = demo();
    let ctx = canonicalize(&f.cart, &f.unit).unwrap();
    assert_eq!(
        serde_json::to_string(&ctx).unwrap(),
        r#"{"currency":"USD","total_minor":9400,"merchant":"mrc_runfast","categories":["gpt:187"],"variants":[{"sku":"sku-trail-10","size":"10","color":"black"}],"max_line_qty":1,"max_unit_minor":9400,"return_days":30,"returns_free":true}"#
    );
    let f = fixture(include_str!("fixtures/bundle-340.json"));
    let ctx = canonicalize(&f.cart, &f.unit).unwrap();
    assert_eq!(
        serde_json::to_string(&ctx).unwrap(),
        r#"{"currency":"USD","total_minor":34000,"merchant":"mrc_runfast","categories":["gpt:100","gpt:1604","gpt:187"],"variants":[{"sku":"BAG-20"},{"sku":"SOCK-6","color":"white"},{"sku":"sku-trail-10","size":"10","color":"black"}],"max_line_qty":3,"max_unit_minor":10700,"return_days":14,"returns_free":false}"#
    );
}

#[test]
fn quantity_is_summed_per_variant() {
    let mut f = demo();
    let line = f.cart.lines[0].clone();
    f.cart.lines = vec![line; 2];
    let u = unit(
        "188.00",
        json!({ "item_total": { "currency_code": "USD", "value": "188.00" } }),
    );
    let ctx = canonicalize(&f.cart, &u).unwrap();
    assert_eq!(ctx.variants.len(), 1);
    assert_eq!(ctx.max_line_qty, 2);
}

#[test]
fn variant_quantity_overflow_is_checked() {
    let mut f = demo();
    f.cart.lines[0].unit_minor = 0;
    f.cart.lines[0].qty = i64::MAX;
    let mut second = f.cart.lines[0].clone();
    second.qty = 1;
    f.cart.lines.push(second);
    let u = unit(
        "0.00",
        json!({ "item_total": { "currency_code": "USD", "value": "0.00" } }),
    );
    assert_eq!(canonicalize(&f.cart, &u), Err(Deny::AmountOverflow));
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
    for value in [
        "99999999999999999999999.00",
        "9999999999999999999999999999999999999999999999.00",
    ] {
        let u = unit(
            value,
            json!({ "item_total": { "currency_code": "USD", "value": value } }),
        );
        assert_eq!(
            canonicalize(&f.cart, &u),
            Err(Deny::AmountOverflow),
            "{value}"
        );
    }
}

#[test]
fn deny_reasons_are_snake_case() {
    assert_eq!(
        serde_json::to_value(Deny::AmountBreakdownMismatch).unwrap(),
        "amount_breakdown_mismatch"
    );
    for (deny, reason) in [
        (Deny::AmountBreakdownMismatch, "amount_breakdown_mismatch"),
        (Deny::CurrencyMismatch, "currency_mismatch"),
        (Deny::AmountOverflow, "amount_overflow"),
        (Deny::InvalidQuantity, "invalid_quantity"),
        (Deny::InvalidAmount, "invalid_amount"),
        (Deny::TooManyLines, "too_many_lines"),
        (Deny::EmptyCart, "empty_cart"),
    ] {
        assert_eq!(serde_json::to_value(deny).unwrap(), reason);
    }
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
            returns_free: false,
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

#[test]
fn cart_and_unit_serialize_back_to_their_wire_form() {
    for json in [
        include_str!("fixtures/demo-shoes.json"),
        include_str!("fixtures/bundle-340.json"),
        include_str!("fixtures/breakdown-mismatch.json"),
    ] {
        let raw: Value = serde_json::from_str(json).unwrap();
        let f = fixture(json);
        assert_eq!(serde_json::to_value(&f.cart).unwrap(), raw["cart"]);
        assert_eq!(serde_json::to_value(&f.unit).unwrap(), raw["unit"]);
    }
}
