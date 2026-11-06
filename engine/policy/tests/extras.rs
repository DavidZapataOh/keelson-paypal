use std::collections::BTreeMap;
use std::str::FromStr;

use cedar_policy::{Effect, Policy, PolicyId, PolicySet, ValidationMode, Validator};
use keelson_canon::{Cart, Context, PayPalUnit, canonicalize};
use keelson_policy::{
    Decision, EngineMeta, EvalInput, Extra, ExtrasError, InvalidExtra, Trace, compile_extras,
    evaluate, evaluate_context, evaluate_context_with_extras, evaluate_with_extras, mandate_agent,
    policies, schema, trace_jcs,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::macros::datetime;

fn context(fixture: &str) -> Context {
    let f: Value = serde_json::from_str(fixture).unwrap();
    let cart: Cart = serde_json::from_value(f["cart"].clone()).unwrap();
    let unit: PayPalUnit = serde_json::from_value(f["unit"].clone()).unwrap();
    canonicalize(&cart, &unit).unwrap()
}

fn input() -> EvalInput {
    let mandate: Value = serde_json::from_str(include_str!(
        "../../../packages/mandate/test/fixtures/demo-mandate.json"
    ))
    .unwrap();
    EvalInput {
        // The authenticated requester: the agent the mandate names.
        agent: mandate_agent(&mandate).unwrap(),
        mandate,
        budget_left_minor: 10_000,
        context: context(include_str!("../../canon/tests/fixtures/demo-shoes.json")),
        now: datetime!(2026-11-05 17:02:11.250 UTC),
        evidence: BTreeMap::new(),
        mandate_hash: [0x11; 32],
        cart_hash: [0x22; 32],
    }
}

fn meta() -> EngineMeta {
    let h = |c: &str| format!("sha256:{}", c.repeat(64));
    EngineMeta::new("0.8.1", "1.3.1", &h("a"), &h("b"), &h("c"))
}

fn run(extras: &[Extra]) -> Trace {
    evaluate_with_extras(&input(), extras, &meta())
}

fn merchant(id: &str) -> Extra {
    Extra::DenyMerchant { id: id.to_owned() }
}

fn category(id: &str) -> Extra {
    Extra::DenyCategory { id: id.to_owned() }
}

#[test]
fn each_extra_denies_the_matching_cart_and_allows_others() {
    let cases = [
        (
            Extra::MaxUnitPrice { minor: 9399 },
            Extra::MaxUnitPrice { minor: 9400 },
        ),
        (merchant("mrc_runfast"), merchant("mrc_other")),
        (category("gpt:187"), category("gpt:166")),
        (
            Extra::RequireReturnDays { min: 31 },
            Extra::RequireReturnDays { min: 30 },
        ),
    ];
    for (deny, allow) in cases {
        let t = run(std::slice::from_ref(&deny));
        assert_eq!(t.decision, Decision::Deny, "{deny:?}");
        assert_eq!(t.fired, ["extra.0"], "{deny:?}");
        assert!(t.errors.is_empty(), "{:?}", t.errors);
        let t = run(std::slice::from_ref(&allow));
        assert_eq!(t.decision, Decision::Allow, "{allow:?}: {:?}", t.fired);
        assert!(t.fields.iter().all(|f| f.pass));
    }
}

#[test]
fn no_extras_evaluates_like_the_base_set() {
    let i = input();
    assert_eq!(
        trace_jcs(&evaluate_with_extras(&i, &[], &meta())),
        trace_jcs(&evaluate(&i, &meta()))
    );
}

#[test]
fn extras_compose_with_the_base_set() {
    let extras: Vec<Extra> = (0..11)
        .map(|n| Extra::RequireReturnDays { min: n })
        .chain([merchant("mrc_runfast"), Extra::MaxUnitPrice { minor: 100 }])
        .collect();
    let mut i = input();
    i.budget_left_minor = 0;
    let t = evaluate_with_extras(&i, &extras, &meta());
    assert_eq!(t.decision, Decision::Deny);
    assert_eq!(t.fired, ["budget", "extra.11", "extra.12"]);
    let mut sorted = t.fired.clone();
    sorted.sort();
    assert_eq!(t.fired, sorted);

    let ids: Vec<_> = t.fields.iter().map(|f| f.id.as_str()).collect();
    let extra_ids: Vec<_> = ids.iter().filter(|id| id.starts_with("extra.")).collect();
    let expected: Vec<String> = (0..13).map(|n| format!("extra.{n}")).collect();
    assert_eq!(extra_ids, expected.iter().collect::<Vec<_>>());
    assert_eq!(ids.len(), evaluate(&i, &meta()).fields.len() + 13);

    let field = |id: &str| t.fields.iter().find(|f| f.id == id).unwrap();
    let price = field("extra.12");
    assert!(!price.pass);
    assert_eq!(price.field, "total");
    assert_eq!(price.color, "green");
    assert_eq!(price.observed, Some(json!(9400)));
    assert_eq!(price.bound, Some(json!(100)));
    let shop = field("extra.11");
    assert_eq!(shop.field, "merchant");
    assert_eq!(shop.observed, Some(json!("mrc_runfast")));
    assert_eq!(shop.bound, Some(json!("mrc_runfast")));
    let days = field("extra.3");
    assert!(days.pass);
    assert_eq!(days.field, "return_policy");
    assert_eq!(days.observed, Some(json!(30)));
    assert_eq!(days.bound, Some(json!(3)));
    assert!(!field("budget").pass);
}

#[test]
fn context_errors_deny_extras_too() {
    let i = input();
    let mut raw = evaluate(&i, &meta()).context;
    raw.as_object_mut().unwrap().remove("max_unit_minor");
    let t = evaluate_context(&i, raw, &meta());
    assert_eq!(t.decision, Decision::Deny);
    assert_eq!(t.errors, ["context.missing:max_unit_minor"]);

    let mut i = input();
    i.context.max_unit_minor = -1;
    let t = evaluate_with_extras(&i, &[Extra::MaxUnitPrice { minor: 1 }], &meta());
    assert_eq!(t.decision, Decision::Deny);
    assert_eq!(t.fired, ["sanity"]);
}

#[test]
fn invalid_extras_deny_with_an_error() {
    let t = run(&[merchant("mrc_other"), Extra::MaxUnitPrice { minor: 0 }]);
    assert_eq!(t.decision, Decision::Deny);
    assert_eq!(t.errors, ["extras.invalid:1"]);
    assert!(t.fields.iter().all(|f| !f.id.starts_with("extra.")));
}

#[test]
fn compiled_policies_are_annotated_forbids_that_validate_strictly() {
    let extras = [
        Extra::MaxUnitPrice { minor: 12_500 },
        merchant("mrc_runfast"),
        category("gpt:187"),
        Extra::RequireReturnDays { min: 0 },
    ];
    let compiled = compile_extras(&extras).unwrap();
    let fields = ["total", "merchant", "category", "return_policy"];
    let mut set = policies().clone();
    for (n, ((id, text), field)) in compiled.iter().zip(fields).enumerate() {
        assert_eq!(*id, format!("extra.{n}"));
        let parsed = PolicySet::from_str(text).unwrap();
        assert_eq!(parsed.policies().count(), 1, "{text}");
        let p = Policy::parse(Some(PolicyId::new(id)), text).unwrap();
        assert_eq!(p.effect(), Effect::Forbid);
        assert_eq!(p.annotation("id"), Some(id.as_str()));
        assert_eq!(p.annotation("field"), Some(field));
        assert_eq!(p.annotation("color"), Some("green"));
        assert!(
            text.contains(r#"action == Keelson::Action::"checkout""#),
            "{text}"
        );
        assert!(!has_arithmetic(&p.to_json().unwrap()), "{text}");
        set.add(p).unwrap();
    }
    let result = Validator::new(schema().clone()).validate(&set, ValidationMode::Strict);
    let errors: Vec<_> = result.validation_errors().map(|e| e.to_string()).collect();
    let warnings: Vec<_> = result
        .validation_warnings()
        .map(|w| w.to_string())
        .collect();
    assert!(errors.is_empty(), "{errors:?}");
    assert!(warnings.is_empty(), "{warnings:?}");
}

#[test]
fn the_grammar_is_closed() {
    let ok: Vec<Extra> = serde_json::from_value(json!([
        { "type": "max_unit_price", "minor": 100 },
        { "type": "deny_merchant", "id": "mrc_runfast" },
        { "type": "deny_category", "id": "gpt:187" },
        { "type": "require_return_days", "min": 30 },
    ]))
    .unwrap();
    assert_eq!(ok.len(), 4);
    for bad in [
        json!({ "type": "permit" }),
        json!({ "type": "forbid", "when": "true" }),
        json!({ "type": "deny_merchant", "id": "mrc_a", "effect": "permit" }),
        json!({ "type": "max_unit_price", "minor": "100" }),
        json!({ "type": "max_unit_price", "minor": 1.5 }),
        json!({ "type": "deny_category" }),
        json!({ "minor": 100 }),
        json!("permit(principal, action, resource);"),
        json!("forbid(principal, action, resource) when { true };"),
    ] {
        assert!(
            serde_json::from_value::<Extra>(bad.clone()).is_err(),
            "{bad}"
        );
    }
}

#[test]
fn meaningless_literals_are_rejected() {
    let max_safe = (1i64 << 53) - 1;
    for (extra, err) in [
        (Extra::MaxUnitPrice { minor: 0 }, InvalidExtra::Price),
        (Extra::MaxUnitPrice { minor: -1 }, InvalidExtra::Price),
        (
            Extra::MaxUnitPrice {
                minor: max_safe + 1,
            },
            InvalidExtra::Price,
        ),
        (
            Extra::RequireReturnDays { min: -1 },
            InvalidExtra::ReturnDays,
        ),
        (
            Extra::RequireReturnDays { min: max_safe + 1 },
            InvalidExtra::ReturnDays,
        ),
    ] {
        assert_eq!(
            compile_extras(&[merchant("mrc_a"), extra]),
            Err(ExtrasError {
                index: 1,
                reason: err
            })
        );
    }
    assert!(compile_extras(&[Extra::MaxUnitPrice { minor: max_safe }]).is_ok());
}

#[test]
fn ids_must_match_their_grammar() {
    let long = format!("mrc_{}", "a".repeat(125));
    for id in [
        "",
        "mrc_",
        "runfast",
        "MRC_runfast",
        "mrc_\u{200b}x",
        "mrc_a\nb",
        "mrc_a\u{0}",
        long.as_str(),
    ] {
        assert!(
            matches!(
                compile_extras(&[merchant(id)]),
                Err(ExtrasError {
                    index: 0,
                    reason: InvalidExtra::MerchantId
                })
            ),
            "{id:?}"
        );
    }
    assert!(compile_extras(&[merchant(&long[..128])]).is_ok());
    for id in [
        "",
        "gpt:",
        "gpt:01",
        "gpt:0",
        "gpt:12a",
        "GPT:1",
        "gpt:187 ",
        " gpt:187",
        "gpt:-1",
        "gpt:١٨٧",
        "gpt:12345678901",
    ] {
        assert!(compile_extras(&[category(id)]).is_err(), "{id:?}");
    }
    for id in ["gpt:1", "gpt:1604", "gpt:1234567890"] {
        assert!(compile_extras(&[category(id)]).is_ok(), "{id:?}");
    }
}

/// The string literal of the single `==` comparison in a policy's JSON form.
fn compared_string(v: &Value) -> Option<&str> {
    match v {
        Value::Object(o) => o
            .get("==")
            .and_then(|eq| eq["right"]["Value"].as_str())
            .or_else(|| o.values().find_map(compared_string)),
        Value::Array(a) => a.iter().find_map(compared_string),
        _ => None,
    }
}

#[test]
fn hostile_ids_stay_inside_their_string_literal() {
    let hostile = [
        r#"mrc_""#,
        r#"mrc_\"#,
        r#"mrc_\""#,
        r#"mrc_"}; permit(principal, action, resource);//"#,
        r#"mrc_" || true || ""#,
        r#"mrc_\u{22}"#,
        concat!("mrc_", "\\", "u0022"),
        "mrc_𝄞_東京_😀",
        "mrc_'*/ @id(\"base\")",
    ];
    for id in hostile {
        let compiled = compile_extras(&[merchant(id)]).unwrap();
        let (pid, text) = &compiled[0];
        let parsed = PolicySet::from_str(text).unwrap();
        assert_eq!(parsed.policies().count(), 1, "{text}");
        let p = Policy::parse(Some(PolicyId::new(pid)), text).unwrap();
        assert_eq!(p.effect(), Effect::Forbid, "{text}");
        assert_eq!(p.annotation("id"), Some("extra.0"));
        assert_eq!(compared_string(&p.to_json().unwrap()), Some(id), "{text}");

        // The extra fires exactly on that merchant id.
        let mut i = input();
        let allowed = evaluate_with_extras(&i, &[merchant(id)], &meta());
        assert_eq!(allowed.decision, Decision::Allow, "{text}");
        i.context.merchant = id.to_owned();
        let t = evaluate_with_extras(&i, &[merchant(id)], &meta());
        assert!(
            t.fired.iter().any(|f| f == "extra.0"),
            "{text}: {:?}",
            t.fired
        );
        assert!(t.errors.is_empty(), "{:?}", t.errors);
    }
}

fn has_arithmetic(v: &Value) -> bool {
    match v {
        Value::Object(o) => o
            .iter()
            .any(|(k, v)| matches!(k.as_str(), "+" | "-" | "*" | "neg") || has_arithmetic(v)),
        Value::Array(a) => a.iter().any(has_arithmetic),
        _ => false,
    }
}

fn extras_hash(extras: &[Extra]) -> String {
    let jcs = keelson_core::jcs(&serde_json::to_value(extras).unwrap()).unwrap();
    let digest = Sha256::digest(jcs.as_bytes());
    format!(
        "sha256:{}",
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

#[test]
fn the_trace_binds_the_extras_in_order() {
    let a = [merchant("mrc_other"), Extra::MaxUnitPrice { minor: 9400 }];
    let b = [Extra::MaxUnitPrice { minor: 9400 }, merchant("mrc_other")];
    let ta = run(&a);
    assert_eq!(ta.extras_hash.as_deref(), Some(extras_hash(&a).as_str()));
    assert_eq!(run(&a).extras_hash, ta.extras_hash);
    assert_ne!(run(&b).extras_hash, ta.extras_hash);
    assert_eq!(evaluate(&input(), &meta()).extras_hash, None);

    let text = serde_json::to_string(&ta).unwrap();
    let at = |k: &str| text.find(&format!("\"{k}\":")).unwrap();
    assert!(at("proof_bundle_hash") < at("extras_hash"));
    assert!(at("extras_hash") < at("mandate_hash"));
    let none = serde_json::to_value(run(&[])).unwrap();
    assert!(none.get("extras_hash").is_none());

    // Invalid extras are bound too, unsafe integers included.
    let bad = run(&[Extra::MaxUnitPrice { minor: i64::MAX }]);
    assert_eq!(bad.decision, Decision::Deny);
    assert!(bad.extras_hash.is_some());
    assert!(!trace_jcs(&bad).is_empty());
}

#[test]
fn replay_with_extras_matches_the_evaluation() {
    let extras = [Extra::RequireReturnDays { min: 31 }, category("gpt:166")];
    let i = input();
    let t = evaluate_with_extras(&i, &extras, &meta());
    let replay = evaluate_context_with_extras(&i, t.context.clone(), &extras, &meta());
    assert_eq!(trace_jcs(&replay), trace_jcs(&t));
    assert_eq!(replay.fired, ["extra.0"]);

    let mut raw = t.context.clone();
    raw["max_unit_minor"] = json!("9400");
    let bad = evaluate_context_with_extras(&i, raw, &extras, &meta());
    assert_eq!(bad.decision, Decision::Deny);
    assert_eq!(bad.errors, ["context.type:max_unit_minor"]);
}

#[test]
fn at_most_sixteen_extras() {
    let extras: Vec<Extra> = (0..17)
        .map(|n| Extra::RequireReturnDays { min: n })
        .collect();
    assert_eq!(
        compile_extras(&extras),
        Err(ExtrasError {
            index: 16,
            reason: InvalidExtra::TooMany
        })
    );
    assert!(compile_extras(&extras[..16]).is_ok());
    let t = run(&extras);
    assert_eq!(t.decision, Decision::Deny);
    assert_eq!(t.errors, ["extras.invalid:too_many"]);
    assert!(t.fields.iter().all(|f| !f.id.starts_with("extra.")));
    assert_eq!(run(&extras[..16]).decision, Decision::Allow);
}

#[test]
fn deserialization_rejects_ambiguous_input() {
    for bad in [
        r#"{"type":"deny_merchant","type":"permit","id":"mrc_a"}"#,
        r#"{"type":"permit","type":"deny_merchant","id":"mrc_a"}"#,
        r#"{"type":"max_unit_price","minor":1,"minor":2}"#,
        r#"{"type":"max_unit_price","minor":1e2}"#,
        r#"{"type":"max_unit_price","minor":100.0}"#,
        r#"{"type":"require_return_days","min":-0}"#,
        r#"{"type":"max_unit_price","minor":18446744073709551615}"#,
        r#"{"type":"max_unit_price","minor":9223372036854775808}"#,
    ] {
        assert!(serde_json::from_str::<Extra>(bad).is_err(), "{bad}");
    }
    for id in ["mrc_a\u{85}", "mrc_\u{feff}a", "mrc_a\u{7f}"] {
        assert_eq!(
            compile_extras(&[merchant(id)]),
            Err(ExtrasError {
                index: 0,
                reason: InvalidExtra::MerchantId
            }),
            "{id:?}"
        );
    }
}

#[test]
fn evidence_never_changes_the_color_of_an_extra() {
    let mut i = input();
    i.evidence = BTreeMap::from([
        (
            "total".to_owned(),
            vec!["ucp:merchant-signature".to_owned()],
        ),
        ("merchant".to_owned(), vec!["operator_attest#1".to_owned()]),
    ]);
    let t = evaluate_with_extras(
        &i,
        &[Extra::MaxUnitPrice { minor: 9400 }, merchant("mrc_a")],
        &meta(),
    );
    for f in t.fields.iter().filter(|f| f.id.starts_with("extra.")) {
        assert_eq!(f.color, "green");
        assert!(f.evidence.is_empty(), "{f:?}");
    }
}
