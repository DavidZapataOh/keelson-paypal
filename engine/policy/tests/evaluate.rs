use std::collections::BTreeMap;

use keelson_canon::{Cart, Context, PayPalUnit, canonicalize};
use keelson_mandate::{Jwk, OpenMandateVerifyOptions, verify_credential};
use keelson_policy::{
    Decision, EngineMeta, EvalInput, Trace, agent_uid, evaluate, evaluate_context, mandate_agent,
    policy_texts, trace_jcs,
};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::macros::datetime;

const NOW: OffsetDateTime = datetime!(2026-11-05 17:02:11.250 UTC);

fn mandate() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/mandate/test/fixtures/demo-mandate.json"
    ))
    .unwrap()
}

fn context(fixture: &str) -> Context {
    let f: Value = serde_json::from_str(fixture).unwrap();
    let cart: Cart = serde_json::from_value(f["cart"].clone()).unwrap();
    let unit: PayPalUnit = serde_json::from_value(f["unit"].clone()).unwrap();
    canonicalize(&cart, &unit).unwrap()
}

fn demo_cart() -> Context {
    context(include_str!("../../canon/tests/fixtures/demo-shoes.json"))
}

fn bundle() -> Context {
    context(include_str!("../../canon/tests/fixtures/bundle-340.json"))
}

/// The registry of the agent the demo mandate names.
const REGISTRY: &str = "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e";

fn input(context: Context) -> EvalInput {
    let mandate = mandate();
    EvalInput {
        // The authenticated requester: here the agent the demo mandate names, ERC-8004 id 42.
        agent: agent_uid(REGISTRY, "42").unwrap(),
        mandate,
        budget_left_minor: 10_000,
        context,
        now: NOW,
        evidence: BTreeMap::from([(
            "total".to_owned(),
            vec!["paypal.authorization.amount".to_owned()],
        )]),
        mandate_hash: [0x11; 32],
        cart_hash: [0x22; 32],
    }
}

fn meta() -> EngineMeta {
    EngineMeta::new(
        "0.8.1",
        "1.3.1",
        &format!("sha256:{}", "a".repeat(64)),
        &format!("sha256:{}", "b".repeat(64)),
        &format!("sha256:{}", "c".repeat(64)),
    )
}

fn field<'a>(t: &'a Trace, id: &str) -> &'a keelson_policy::FieldTrace {
    t.fields.iter().find(|f| f.id == id).unwrap()
}

#[test]
fn demo_cart_is_allowed() {
    let t = evaluate(&input(demo_cart()), &meta());
    assert_eq!(t.decision, Decision::Allow, "{:?}", t.errors);
    assert!(t.fired.is_empty());
    assert!(t.errors.is_empty());
    let ids: Vec<_> = t.fields.iter().map(|f| f.id.as_str()).collect();
    let expected: Vec<_> = policy_texts()
        .keys()
        .map(String::as_str)
        .filter(|id| *id != "base")
        .collect();
    assert_eq!(ids, expected);
    assert!(t.fields.iter().all(|f| f.pass), "{:?}", t.fields);
    // The mandate leaves color unconstrained, so the projected variant has none.
    assert_eq!(
        t.context["variants"],
        json!([{ "sku": "sku-trail-10", "size": "10" }])
    );
    assert_eq!(field(&t, "amount").observed, Some(json!(9400)));
    assert_eq!(
        field(&t, "amount").evidence,
        ["paypal.authorization.amount"]
    );
}

#[test]
fn bundle_is_denied_on_amount_and_variant() {
    let t = evaluate(&input(bundle()), &meta());
    assert_eq!(t.decision, Decision::Deny);
    assert!(t.errors.is_empty(), "{:?}", t.errors);
    for id in [
        "amount", "variant", "budget", "category", "quantity", "returns",
    ] {
        assert!(t.fired.iter().any(|f| f == id), "{id} in {:?}", t.fired);
    }
    let mut sorted = t.fired.clone();
    sorted.sort();
    assert_eq!(t.fired, sorted);
    let amount = field(&t, "amount");
    assert!(!amount.pass);
    assert_eq!(amount.field, "total");
    assert_eq!(amount.color, "green");
    assert_eq!(amount.observed, Some(json!(34000)));
    assert_eq!(amount.bound, Some(json!(10000)));
    assert!(field(&t, "currency").pass);
    assert!(field(&t, "merchant").pass);
}

#[test]
fn wrong_agent_is_denied() {
    let mut i = input(demo_cart());
    assert_eq!(i.agent, mandate_agent(&i.mandate).unwrap());
    // Another agent authenticated for this request, holding the same mandate.
    i.agent = agent_uid(REGISTRY, "43").unwrap();
    let t = evaluate(&i, &meta());
    assert_eq!(t.decision, Decision::Deny);
    assert_eq!(t.fired, ["agent"]);
    assert!(!field(&t, "agent").pass);
}

#[test]
fn window_end_is_exclusive() {
    let mut i = input(demo_cart());
    i.now = OffsetDateTime::from_unix_timestamp(1_794_355_200).unwrap();
    let t = evaluate(&i, &meta());
    assert_eq!(t.decision, Decision::Deny);
    assert_eq!(t.fired, ["window"]);
    i.now = OffsetDateTime::from_unix_timestamp_nanos(1_794_355_199_999_000_000).unwrap();
    assert_eq!(evaluate(&i, &meta()).decision, Decision::Allow);
}

#[test]
fn window_start_is_inclusive() {
    let mut i = input(demo_cart());
    i.now = OffsetDateTime::from_unix_timestamp(1_793_750_400).unwrap();
    let t = evaluate(&i, &meta());
    assert_eq!(t.decision, Decision::Allow, "{:?}", t.errors);
    let window = field(&t, "window");
    assert_eq!(window.observed, Some(json!(1_793_750_400_000i64)));
    assert_eq!(
        window.bound,
        Some(
            json!({ "expires_at_ms": 1_794_355_200_000i64, "not_before_ms": 1_793_750_400_000i64 })
        )
    );
    i.now = OffsetDateTime::from_unix_timestamp_nanos(1_793_750_399_999_999_999).unwrap();
    let t = evaluate(&i, &meta());
    assert_eq!(t.fired, ["window"]);
    assert_eq!(
        field(&t, "window").observed,
        Some(json!(1_793_750_399_999i64))
    );
}

#[test]
fn a_clock_outside_years_0_to_9999_denies() {
    let mut i = input(demo_cart());
    i.now = OffsetDateTime::from_unix_timestamp(-62_167_219_201).unwrap();
    let t = evaluate(&i, &meta());
    denied_with(&t, &["context.type:now_ms"]);
    assert_eq!(t.context["now_ms"], Value::Null);
}

fn raw_context() -> (EvalInput, Value) {
    let i = input(demo_cart());
    let raw = evaluate(&i, &meta()).context;
    (i, raw)
}

fn denied_with(t: &Trace, codes: &[&str]) {
    assert_eq!(t.decision, Decision::Deny);
    assert_eq!(t.errors, codes, "{:?}", t.fired);
}

#[test]
fn missing_context_attribute_denies_with_an_error() {
    let (i, mut raw) = raw_context();
    raw.as_object_mut().unwrap().remove("return_days");
    let t = evaluate_context(&i, raw, &meta());
    denied_with(&t, &["context.missing:return_days"]);
    assert!(t.fields.iter().all(|f| !f.pass));
}

#[test]
fn ill_typed_context_attribute_denies_with_an_error() {
    let (i, mut raw) = raw_context();
    raw["return_days"] = json!("30");
    raw["returns_free"] = json!(1);
    denied_with(
        &evaluate_context(&i, raw, &meta()),
        &["context.type:return_days", "context.type:returns_free"],
    );
}

#[test]
fn raw_context_shape_is_checked() {
    let (i, raw) = raw_context();
    let with = |key: &str, value: Value| {
        let mut r = raw.clone();
        r[key] = value;
        evaluate_context(&i, r, &meta())
    };
    denied_with(&with("extra", json!(1)), &["context.extra:extra"]);
    denied_with(
        &with("now_ms", json!("1793898131250")),
        &["context.type:now_ms"],
    );
    denied_with(
        &with(
            "variants",
            json!([{ "sku": "sku-trail-10", "size_us": "10" }]),
        ),
        &["context.type:variants"],
    );
    denied_with(
        &with("categories", json!([187])),
        &["context.type:categories"],
    );
    denied_with(
        &with("total_minor", json!(94.5)),
        &["context.type:total_minor"],
    );
    denied_with(
        &evaluate_context(&i, json!([raw]), &meta()),
        &["context.invalid"],
    );
    assert_eq!(
        evaluate_context(&i, raw.clone(), &meta()).decision,
        Decision::Allow
    );
}

#[test]
fn empty_categories_deny() {
    let mut i = input(demo_cart());
    i.context.categories.clear();
    denied_with(&evaluate(&i, &meta()), &["context.empty:categories"]);

    let mut i = input(demo_cart());
    i.context.categories = [String::new()].into();
    denied_with(&evaluate(&i, &meta()), &["context.empty:categories"]);
}

#[test]
fn empty_carts_deny() {
    let mut i = input(demo_cart());
    i.context.variants.clear();
    i.context.quantities.clear();
    i.context.max_line_qty = 0;
    denied_with(&evaluate(&i, &meta()), &["context.empty:variants"]);

    let (i, mut raw) = raw_context();
    raw["variants"] = json!([]);
    raw["categories"] = json!([]);
    denied_with(
        &evaluate_context(&i, raw, &meta()),
        &["context.empty:categories", "context.empty:variants"],
    );
}

#[test]
fn projected_variants_sum_their_quantities() {
    let mut i = input(demo_cart());
    let mut white = i.context.variants.first().unwrap().clone();
    white.color = Some("white".to_owned());
    i.context.variants.insert(white.clone());
    i.context.quantities.insert(white, 1);
    let t = evaluate(&i, &meta());
    assert_eq!(t.context["max_line_qty"], json!(2));
    assert_eq!(t.fired, ["quantity"]);
}

#[test]
fn quantity_overflow_denies_with_an_error() {
    let mut i = input(demo_cart());
    let mut white = i.context.variants.first().unwrap().clone();
    white.color = Some("white".to_owned());
    i.context.variants.insert(white.clone());
    i.context.quantities.insert(white, i64::MAX);
    i.context.max_line_qty = i64::MAX;
    let t = evaluate(&i, &meta());
    // The canonical maximum is kept, and it is not a safe integer either.
    denied_with(&t, &["context.quantities", "context.type:max_line_qty"]);
    assert!(!field(&t, "quantity").pass);
}

#[test]
fn quantities_must_match_variants() {
    let mut i = input(demo_cart());
    i.context.quantities.clear();
    denied_with(&evaluate(&i, &meta()), &["context.quantities"]);
}

#[test]
fn max_line_qty_must_match_quantities() {
    let mut i = input(demo_cart());
    i.context.max_line_qty = 5;
    denied_with(&evaluate(&i, &meta()), &["context.quantities"]);
}

#[test]
fn quantities_must_be_positive() {
    let mut i = input(demo_cart());
    let mut white = i.context.variants.first().unwrap().clone();
    white.color = Some("white".to_owned());
    i.context.variants.insert(white.clone());
    i.context.quantities = i.context.variants.iter().cloned().zip([3, -2]).collect();
    i.context.max_line_qty = 3;
    denied_with(&evaluate(&i, &meta()), &["context.quantities"]);

    let mut i = input(demo_cart());
    for q in i.context.quantities.values_mut() {
        *q = 0;
    }
    i.context.max_line_qty = 0;
    denied_with(&evaluate(&i, &meta()), &["context.quantities"]);
}

#[test]
fn unsafe_integers_deny_and_still_serialize() {
    let mut i = input(demo_cart());
    i.context.total_minor = 1 << 60;
    let t = evaluate(&i, &meta());
    denied_with(&t, &["context.type:total_minor"]);
    assert!(!trace_jcs(&t).is_empty());
}

#[test]
fn malformed_mandates_deny_without_panicking() {
    for (mandate, code) in [
        (json!(null), "entity.invalid:mid"),
        (json!({}), "entity.invalid:mid"),
        (json!([1, 2]), "entity.invalid:mid"),
        (json!({ "mid": 7 }), "entity.invalid:mid"),
        (
            {
                let mut m = mandate();
                m["payment"]["constraints"] = json!("nope");
                m
            },
            "entity.invalid:payment.constraints",
        ),
    ] {
        let mut i = input(demo_cart());
        i.mandate = mandate;
        let t = evaluate(&i, &meta());
        denied_with(&t, &[code]);
        assert!(!trace_jcs(&t).is_empty());
    }
}

#[test]
fn cryptographic_evidence_raises_the_color() {
    let mut i = input(demo_cart());
    i.evidence
        .insert("variant".to_owned(), vec!["operator_attest#1".to_owned()]);
    i.evidence
        .insert("category".to_owned(), vec!["zktls:sha256:00".to_owned()]);
    i.evidence.insert(
        "return_policy".to_owned(),
        vec!["ucp:mrc_runfast".to_owned()],
    );
    let t = evaluate(&i, &meta());
    assert_eq!(field(&t, "variant").color, "amber");
    assert_eq!(field(&t, "category").color, "green");
    assert_eq!(field(&t, "returns").color, "green");
    assert_eq!(field(&t, "returns_free").color, "green");
    assert_eq!(field(&t, "variant").evidence, ["operator_attest#1"]);
}

#[test]
fn trace_has_the_eval_layout() {
    let t = evaluate(&input(bundle()), &meta());
    let text = serde_json::to_string(&t).unwrap();
    let keys = [
        "\"v\":",
        "\"engine\":",
        "\"policy_set_hash\":",
        "\"schema_hash\":",
        "\"proof_bundle_hash\":",
        "\"mandate_hash\":",
        "\"cart_hash\":",
        "\"context\":",
        "\"decision\":",
        "\"fired\":",
        "\"fields\":",
        "\"errors\":",
        "\"t_tee\":",
    ];
    let at: Vec<_> = keys.iter().map(|k| text.find(k).unwrap()).collect();
    assert!(at.windows(2).all(|w| w[0] < w[1]), "{text}");
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["v"], "keelson.eval/1");
    assert_eq!(v["decision"], "deny");
    assert_eq!(
        v["engine"],
        json!({
            "cedar_policy": "4.14.1",
            "lang": "4.6",
            "symcc": "0.8.1",
            "cvc5": "1.3.1",
            "oci_digest": format!("sha256:{}", "a".repeat(64)),
            "canonicalizer": format!("sha256:{}", "b".repeat(64)),
        })
    );
    assert_eq!(v["proof_bundle_hash"], format!("sha256:{}", "c".repeat(64)));
    assert_eq!(v["policy_set_hash"], keelson_policy::policy_set_hash_tag());
    assert_eq!(v["schema_hash"], keelson_policy::schema_hash_tag());
    assert_eq!(v["mandate_hash"], format!("0x{}", "11".repeat(32)));
    assert_eq!(v["cart_hash"], format!("sha256:{}", "22".repeat(32)));
    assert_eq!(v["t_tee"], "2026-11-05T17:02:11Z");
    assert_eq!(v["context"]["now_ms"], 1_793_898_131_250i64);
    assert!(v["context"].get("now").is_none());
    let amount = v["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["id"] == "amount")
        .unwrap();
    let amount_keys: Vec<_> = amount.as_object().unwrap().keys().cloned().collect();
    let mut expected = vec![
        "bound", "color", "evidence", "field", "id", "observed", "pass",
    ];
    expected.sort();
    let mut got = amount_keys.clone();
    got.sort();
    assert_eq!(got, expected);
}

#[test]
fn trace_jcs_is_deterministic() {
    let i = input(bundle());
    let first = trace_jcs(&evaluate(&i, &meta()));
    for _ in 0..100 {
        assert_eq!(trace_jcs(&evaluate(&i, &meta())), first);
    }
    let v: Value = serde_json::from_slice(&first).unwrap();
    assert_eq!(keelson_core::jcs(&v).unwrap().into_bytes(), first);
}

/// Numbers are read as JSON carries them exactly, the same in every JSON implementation: an
/// integer is a safe integer, with or without a fraction or exponent, and `-0` is not one.
#[test]
fn mandate_and_context_integers_are_safe_integers() {
    let with = |path: &[&str], ty: &str, value: Value| {
        let mut i = input(demo_cart());
        let group = &mut i.mandate[path[0]]["constraints"];
        let c = group
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|c| c["type"] == ty)
            .unwrap();
        c[path[1]] = value;
        evaluate(&i, &meta())
    };
    for bad in [json!(9_007_199_254_740_992i64), json!(-0.0), json!(1.5)] {
        let t = with(&["payment", "max"], "payment.amount_range", bad.clone());
        assert_eq!(
            t.errors,
            ["entity.invalid:payment.amount_range.max"],
            "{bad}"
        );
        let t = with(&["checkout", "min_days"], "keelson.returns", bad.clone());
        assert_eq!(
            t.errors,
            ["entity.invalid:keelson.returns.min_days"],
            "{bad}"
        );
    }
    let exact = trace_jcs(&evaluate(&input(demo_cart()), &meta()));
    for same in [
        json!(10_000.0),
        serde_json::from_str::<Value>("1E4").unwrap(),
    ] {
        let t = with(&["payment", "max"], "payment.amount_range", same);
        assert_eq!(trace_jcs(&t), exact);
    }

    let i = input(demo_cart());
    let replay = |key: &str, value: Value| {
        let mut c = evaluate(&i, &meta()).context;
        c[key] = value;
        evaluate_context(&i, c, &meta())
    };
    let t = replay("total_minor", json!(9400.0));
    assert_eq!(t.decision, Decision::Allow, "{:?}", t.errors);
    assert_eq!(t.context["total_minor"], json!(9400));
    let t = replay("total_minor", json!(-0.0));
    assert_eq!(t.errors, ["context.type:total_minor"]);
    assert_eq!(t.context["total_minor"], json!("-0.0"));
}

#[test]
fn agent_uids_are_canonical() {
    assert_eq!(
        agent_uid("reg/with/slashes", "0").as_deref(),
        Some("reg/with/slashes/0")
    );
    for id in ["", "042", "4a", "-1", "+5", "٣"] {
        assert_eq!(agent_uid(REGISTRY, id), None, "{id:?}");
    }
}

/// The first unsupported `keelson.attributes` key names the error, in UTF-8 byte order of the
/// keys, whatever order the mandate writes them in.
#[test]
fn attribute_errors_do_not_depend_on_key_order() {
    let with = |must: &str| {
        let mut i = input(demo_cart());
        let checkout = i.mandate["checkout"]["constraints"].as_array_mut().unwrap();
        let attrs = checkout
            .iter_mut()
            .find(|c| c["type"] == "keelson.attributes")
            .unwrap();
        attrs["must"] = serde_json::from_str(must).unwrap();
        evaluate(&i, &meta())
    };
    for (a, b, field) in [
        (r#"{"fit":"x","10":"y"}"#, r#"{"10":"y","fit":"x"}"#, "10"),
        (
            r#"{"size_us":"10","width":1,"fit":"x"}"#,
            r#"{"width":1,"fit":"x","size_us":"10"}"#,
            "fit",
        ),
        (r#"{"é":"x","z":"y"}"#, r#"{"z":"y","é":"x"}"#, "z"),
    ] {
        let t = with(a);
        assert_eq!(
            t.errors,
            [format!("entity.invalid:keelson.attributes.must.{field}")]
        );
        assert_eq!(trace_jcs(&t), trace_jcs(&with(b)));
    }
}

/// A signed open mandate, verified and decoded, allows the cart it was issued for.
#[test]
fn a_signed_open_mandate_allows_its_cart() {
    let vectors: Vec<Value> = serde_json::from_str(include_str!(
        "../../../packages/mandate/test/vectors/credentials.json"
    ))
    .unwrap();
    let valid = &vectors.iter().find(|v| v["name"] == "l2/valid").unwrap()["input"];
    let o = &valid["opts"];
    let opts = OpenMandateVerifyOptions {
        expected_aud: o["expectedAud"].as_str().unwrap().into(),
        expected_nonce: o["expectedNonce"].as_str().unwrap().into(),
        now: o["now"].as_i64().unwrap(),
        max_skew_sec: o["maxSkewSec"].as_i64().unwrap(),
    };
    let jwk = Jwk::from_value(&valid["jwk"]).unwrap();
    let verify =
        |token: &str| verify_credential(token, valid["typ"].as_str().unwrap(), &jwk, Some(&opts));
    let token = valid["token"].as_str().unwrap();
    let mandate = verify(token).unwrap().claims;

    let mut i = input(demo_cart());
    i.mandate = Value::Object(mandate);
    let t = evaluate(&i, &meta());
    assert_eq!(t.decision, Decision::Allow, "{:?} {:?}", t.fired, t.errors);

    // Any change to a disclosure fails verification before anything is evaluated.
    let disclosure = token.find('~').unwrap() + 3;
    let mut tampered = token.as_bytes().to_vec();
    tampered[disclosure] = if tampered[disclosure] == b'A' {
        b'B'
    } else {
        b'A'
    };
    assert!(verify(std::str::from_utf8(&tampered).unwrap()).is_err());
}

/// The demo mandate with each line's acceptable items replaced by `items`.
fn with_items(items: &[&[&str]]) -> Value {
    let mut m = mandate();
    let lines = m["checkout"]["constraints"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|c| c["type"] == "checkout.line_items")
        .unwrap();
    lines["items"] = items
        .iter()
        .enumerate()
        .map(|(n, ids)| {
            json!({
                "id": format!("l{n}"),
                "acceptable_items": ids.iter().map(|id| json!({ "id": id, "title": "Trail shoe" })).collect::<Vec<_>>(),
                "quantity": 1,
            })
        })
        .collect();
    m
}

/// The demo cart with its single variant under each of `skus`, one of each.
fn cart_of(skus: &[&str]) -> Context {
    let mut c = demo_cart();
    let v = c.variants.first().unwrap().clone();
    c.quantities = skus
        .iter()
        .map(|sku| {
            let mut v = v.clone();
            v.sku = (*sku).to_owned();
            (v, 1)
        })
        .collect();
    c.variants = c.quantities.keys().cloned().collect();
    c.max_line_qty = 1;
    c
}

#[test]
fn any_item_allows_every_sku_within_the_other_bounds() {
    let mut i = input(cart_of(&["sku-road-9"]));
    i.mandate = with_items(&[&["*"]]);
    let t = evaluate(&i, &meta());
    assert_eq!(t.decision, Decision::Allow, "{:?} {:?}", t.fired, t.errors);
    assert_eq!(t.context["variants"], json!([{ "sku": "*", "size": "10" }]));
    assert_eq!(
        field(&t, "variant").bound,
        Some(json!([{ "sku": "*", "size": "10" }]))
    );

    // The size the mandate requires still binds.
    let mut v = i.context.variants.pop_first().unwrap();
    i.context.quantities.clear();
    v.size = Some("11".to_owned());
    i.context.variants.insert(v.clone());
    i.context.quantities.insert(v, 1);
    assert_eq!(evaluate(&i, &meta()).fired, ["variant"]);
}

#[test]
fn any_item_adds_the_quantities_of_every_sku() {
    let mut i = input(cart_of(&["sku-road-9", "sku-trail-10"]));
    i.mandate = with_items(&[&["*"]]);
    let t = evaluate(&i, &meta());
    assert_eq!(t.context["variants"], json!([{ "sku": "*", "size": "10" }]));
    assert_eq!(t.context["max_line_qty"], json!(2));
    assert_eq!(t.fired, ["quantity"]);
}

#[test]
fn any_item_mixed_with_concrete_items_denies() {
    for items in [
        &[&["*"][..], &["sku-trail-10"][..]][..],
        &[&["sku-trail-10"][..], &["*"][..]][..],
        &[&["*", "sku-trail-10"][..]][..],
    ] {
        let mut i = input(demo_cart());
        i.mandate = with_items(items);
        denied_with(
            &evaluate(&i, &meta()),
            &["entity.invalid:checkout.line_items"],
        );
    }
}
