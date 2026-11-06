use std::collections::BTreeMap;

use keelson_canon::{Cart, Context, PayPalUnit, canonicalize};
use keelson_policy::{
    Decision, EngineMeta, EvalInput, Trace, evaluate, evaluate_context, mandate_agent,
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

fn input(context: Context) -> EvalInput {
    let mandate = mandate();
    EvalInput {
        agent: mandate_agent(&mandate).unwrap(),
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
    i.agent = "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e/43".to_owned();
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
fn missing_context_attribute_denies_with_an_error() {
    let i = input(demo_cart());
    let mut raw = evaluate(&i, &meta()).context;
    raw.as_object_mut().unwrap().remove("return_days");
    let t = evaluate_context(&i, raw, &meta());
    assert_eq!(t.decision, Decision::Deny);
    assert!(!t.errors.is_empty());
    assert!(t.fields.iter().all(|f| !f.pass));
}

#[test]
fn ill_typed_context_attribute_denies_with_an_error() {
    let i = input(demo_cart());
    let mut raw = evaluate(&i, &meta()).context;
    raw["return_days"] = json!("30");
    let t = evaluate_context(&i, raw, &meta());
    assert_eq!(t.decision, Decision::Deny);
    assert!(!t.errors.is_empty());
}

#[test]
fn empty_categories_deny() {
    let mut i = input(demo_cart());
    i.context.categories.clear();
    let t = evaluate(&i, &meta());
    assert_eq!(t.decision, Decision::Deny);
    assert!(!t.errors.is_empty());

    let mut i = input(demo_cart());
    i.context.categories = [String::new()].into();
    let t = evaluate(&i, &meta());
    assert_eq!(t.decision, Decision::Deny);
    assert!(!t.errors.is_empty());
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
    let t = evaluate(&i, &meta());
    assert_eq!(t.decision, Decision::Deny);
    assert!(!t.errors.is_empty());
}

#[test]
fn quantities_must_match_variants() {
    let mut i = input(demo_cart());
    i.context.quantities.clear();
    let t = evaluate(&i, &meta());
    assert_eq!(t.decision, Decision::Deny);
    assert!(!t.errors.is_empty());
}

#[test]
fn unsafe_integers_deny_and_still_serialize() {
    let mut i = input(demo_cart());
    i.context.total_minor = 1 << 60;
    let t = evaluate(&i, &meta());
    assert_eq!(t.decision, Decision::Deny);
    assert!(!t.errors.is_empty());
    assert!(!trace_jcs(&t).is_empty());
}

#[test]
fn malformed_mandates_deny_without_panicking() {
    for mandate in [
        json!(null),
        json!({}),
        json!([1, 2]),
        json!({ "mid": 7 }),
        {
            let mut m = mandate();
            m["payment"]["constraints"] = json!("nope");
            m
        },
    ] {
        let mut i = input(demo_cart());
        i.mandate = mandate;
        let t = evaluate(&i, &meta());
        assert_eq!(t.decision, Decision::Deny);
        assert!(!t.errors.is_empty());
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
    assert_eq!(
        v["context"]["now"],
        json!({ "__extn": { "fn": "datetime", "arg": "2026-11-05T17:02:11.250Z" } })
    );
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
