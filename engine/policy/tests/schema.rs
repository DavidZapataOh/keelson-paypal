use std::collections::BTreeSet;

use cedar_policy::{Effect, Entities, Policy, PolicyId, ValidationMode, Validator};
use keelson_policy::{
    POLICY_SET_SRC, PolicyError, SCHEMA_SRC, mandate_agent, mandate_entity, policies,
    policy_set_hash, policy_set_hash_tag, policy_texts, schema, schema_hash, schema_hash_tag,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const POLICY_IDS: [&str; 13] = [
    "agent",
    "amount",
    "base",
    "budget",
    "category",
    "currency",
    "merchant",
    "quantity",
    "returns",
    "returns_free",
    "sanity",
    "variant",
    "window",
];

/// Each policy `@field` and the `fieldColors` field it is shown as on the mandate card. The cart
/// sanity check has no card field.
const CARD_FIELDS: [(&str, Option<&str>); 11] = [
    ("agent", Some("agent")),
    ("cart", None),
    ("currency", Some("currency")),
    ("total", Some("total")),
    ("budget", Some("budget")),
    ("merchant", Some("merchant")),
    ("deadline", Some("deadline")),
    ("quantity", Some("quantity")),
    ("category", Some("category")),
    ("variant", Some("variant")),
    ("return_policy", Some("return_policy")),
];

fn demo() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/mandate/test/fixtures/demo-mandate.json"
    ))
    .expect("demo mandate is valid JSON")
}

#[test]
fn schema_parses_without_warnings() {
    let (_, warnings) =
        cedar_policy::Schema::from_cedarschema_str(SCHEMA_SRC).expect("schema parses");
    let warnings: Vec<_> = warnings.map(|w| w.to_string()).collect();
    assert!(warnings.is_empty(), "{warnings:?}");
}

#[test]
fn policy_set_validates_strictly_without_warnings() {
    let result = Validator::new(schema().clone()).validate(policies(), ValidationMode::Strict);
    let errors: Vec<_> = result.validation_errors().map(|e| e.to_string()).collect();
    let warnings: Vec<_> = result
        .validation_warnings()
        .map(|w| w.to_string())
        .collect();
    assert!(errors.is_empty(), "{errors:?}");
    assert!(warnings.is_empty(), "{warnings:?}");
    assert!(result.validation_passed_without_warnings());
}

#[test]
fn policies_are_keyed_by_their_id_annotation() {
    let ids: BTreeSet<_> = policies().policies().map(|p| p.id().to_string()).collect();
    assert_eq!(ids, POLICY_IDS.map(String::from).into());
    assert_eq!(
        policy_texts()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        POLICY_IDS
    );
    for p in policies().policies() {
        assert_eq!(p.annotation("id"), Some(p.id().to_string().as_str()));
    }
}

#[test]
fn every_policy_but_base_is_an_annotated_forbid() {
    let base = policies()
        .policy(&PolicyId::new("base"))
        .expect("base exists");
    assert_eq!(base.effect(), Effect::Permit);
    for p in policies()
        .policies()
        .filter(|p| p.id().to_string() != "base")
    {
        assert_eq!(p.effect(), Effect::Forbid, "{}", p.id());
        for key in ["id", "field", "color"] {
            assert!(p.annotation(key).is_some(), "{} lacks @{key}", p.id());
        }
    }
}

#[test]
fn every_forbid_has_the_full_checkout_head() {
    for (id, text) in policy_texts() {
        let head = if id == "base" { "permit" } else { "forbid" };
        let expected =
            format!("{head}(principal, action == Keelson::Action::\"checkout\", resource)");
        assert!(text.contains(&expected), "{id}: {text}");
    }
}

#[test]
fn colors_match_the_card_defaults() {
    let card: Value = serde_json::from_str(include_str!(
        "../../../packages/mandate/test/vectors/colors.json"
    ))
    .expect("colors vector is valid JSON");
    for p in policies().policies() {
        let field = p.annotation("field").expect("@field");
        let (_, card_field) = CARD_FIELDS
            .iter()
            .find(|(f, _)| *f == field)
            .unwrap_or_else(|| panic!("{field} is not in the card table"));
        if let Some(card_field) = card_field {
            assert_eq!(
                Some(p.annotation("color").expect("@color")),
                card[card_field].as_str(),
                "{}",
                p.id()
            );
        }
    }
}

#[test]
fn demo_mandate_entity_matches_the_schema() {
    let entity = mandate_entity(&demo(), 7500).expect("entity builds");
    Entities::from_entities([entity.clone()], Some(schema())).expect("entity conforms to schema");
    let agent = "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e/42";
    assert_eq!(mandate_agent(&demo()).expect("agent"), agent);
    assert_eq!(
        entity.to_json_value().expect("entity serializes"),
        json!({
            "uid": { "type": "Keelson::Mandate", "id": "01JBXG3K5N7Q9R2T4V6W8Y0Z1A" },
            "attrs": {
                "agent": { "__entity": { "type": "Keelson::Agent", "id": agent } },
                "currency": "USD",
                "max_total_minor": 10000,
                "budget_left_minor": 7500,
                "merchants": ["mrc_runfast"],
                "categories": ["gpt:187"],
                "variants": [{ "sku": "sku-trail-10", "size": "10" }],
                "max_qty_per_line": 1,
                "not_before_ms": 1_793_750_400_000i64,
                "expires_at_ms": 1_794_355_200_000i64,
                "min_return_days": 30,
                "returns_free_required": true
            },
            "parents": []
        })
    );
}

#[test]
fn deadline_is_the_earlier_of_expiry_and_execution_date() {
    let mut m = demo();
    m["payment"]["constraints"][3]["not_after"] = json!("2026-11-05T12:00:00Z");
    let attrs = mandate_entity(&m, 0)
        .expect("entity builds")
        .to_json_value()
        .expect("entity serializes");
    assert_eq!(attrs["attrs"]["expires_at_ms"], 1_793_880_000_001i64);
}

#[test]
fn window_bounds_are_epoch_milliseconds_within_years_0_to_9999() {
    let first = -62_167_219_200i64;
    let last = 253_402_300_799i64;
    let mut m = demo();
    m["nbf"] = json!(first);
    assert_eq!(attrs(&m, 0)["not_before_ms"], first * 1000);
    m["nbf"] = json!(first - 1);
    assert!(
        matches!(mandate_entity(&m, 0), Err(PolicyError::Mandate { field, .. }) if field == "nbf")
    );
    let mut m = demo();
    m["exp"] = json!(last);
    m["payment"]["constraints"][3]["not_after"] = json!("9999-12-31T23:59:59.999Z");
    assert_eq!(attrs(&m, 0)["expires_at_ms"], last * 1000);
    // The end is exclusive, but it must still be an instant within the range.
    m["exp"] = json!(last + 1);
    assert!(
        matches!(mandate_entity(&m, 0), Err(PolicyError::Mandate { field, .. }) if field == "exp")
    );
    // The window ends at whichever bound comes first, and an error names that bound.
    m["exp"] = json!(last + 2);
    assert!(
        matches!(mandate_entity(&m, 0), Err(PolicyError::Mandate { field, .. })
        if field == "payment.execution_date.not_after")
    );
}

#[test]
fn absent_optional_constraints_leave_open_bounds_or_none() {
    let mut m = demo();
    m["checkout"]["constraints"] = json!([m["checkout"]["constraints"][0]]);
    let attrs = mandate_entity(&m, 0)
        .expect("entity builds")
        .to_json_value()
        .expect("entity serializes");
    let attrs = &attrs["attrs"];
    assert_eq!(attrs["variants"], json!([]));
    assert_eq!(attrs["max_qty_per_line"], 0);
    assert_eq!(attrs["min_return_days"], 0);
    assert_eq!(attrs["returns_free_required"], false);
    assert_eq!(
        attrs["categories"].as_array().map(Vec::len),
        Some(keelson_mandate::CATEGORY_IDS.len())
    );
}

#[test]
fn malformed_mandates_are_rejected() {
    let mut m = demo();
    m["checkout"]["constraints"][3]["must"]["width"] = json!("wide");
    assert!(mandate_entity(&m, 0).is_err());
    let mut m = demo();
    m["payment"]["constraints"][0]["max"] = json!("100");
    assert!(mandate_entity(&m, 0).is_err());
    assert!(mandate_entity(&json!({}), 0).is_err());
}

#[test]
fn duplicate_constraints_are_rejected() {
    let mut m = demo();
    let mut lower = m["payment"]["constraints"][0].clone();
    lower["max"] = json!(1);
    m["payment"]["constraints"]
        .as_array_mut()
        .expect("constraints")
        .push(lower);
    assert!(mandate_entity(&m, 0).is_err());
    let mut m = demo();
    let returns = m["checkout"]["constraints"][4].clone();
    m["checkout"]["constraints"]
        .as_array_mut()
        .expect("constraints")
        .push(returns);
    assert!(mandate_entity(&m, 0).is_err());
}

fn attrs(m: &Value, budget_left_minor: i64) -> Value {
    mandate_entity(m, budget_left_minor)
        .expect("entity builds")
        .to_json_value()
        .expect("entity serializes")["attrs"]
        .clone()
}

#[test]
fn quantity_bound_is_the_smallest_line_quantity() {
    let mut m = demo();
    m["checkout"]["constraints"][1]["items"] = json!([
        { "id": "l1", "acceptable_items": [{ "id": "A" }], "quantity": 1 },
        { "id": "l2", "acceptable_items": [{ "id": "B" }], "quantity": 3 }
    ]);
    assert_eq!(attrs(&m, 0)["max_qty_per_line"], 1);
}

#[test]
fn budget_left_is_capped_by_the_mandate_budget() {
    assert_eq!(attrs(&demo(), 50_000)["budget_left_minor"], 10000);
    assert_eq!(attrs(&demo(), 4000)["budget_left_minor"], 4000);
}

#[test]
fn free_returns_are_required_only_when_the_mandate_says_so() {
    let mut m = demo();
    m["checkout"]["constraints"][4]["free"] = json!(false);
    assert_eq!(attrs(&m, 0)["returns_free_required"], false);
}

#[test]
fn agent_ids_must_be_canonical_decimals() {
    for id in ["", "042", "4/2", "x"] {
        let mut m = demo();
        m["agent"]["operator"]["agent_id"] = json!(id);
        assert!(mandate_agent(&m).is_err(), "{id:?}");
        assert!(mandate_entity(&m, 0).is_err(), "{id:?}");
    }
    let mut m = demo();
    m["agent"]["operator"]["agent_id"] = json!("0");
    assert!(mandate_agent(&m).is_ok());
}

/// Whether a policy's JSON form uses an arithmetic operator anywhere.
fn has_arithmetic(v: &Value) -> bool {
    match v {
        Value::Object(o) => o
            .iter()
            .any(|(k, v)| matches!(k.as_str(), "+" | "-" | "*" | "neg") || has_arithmetic(v)),
        Value::Array(a) => a.iter().any(has_arithmetic),
        _ => false,
    }
}

#[test]
fn policies_contain_no_arithmetic() {
    let probe = Policy::parse(
        None,
        "forbid(principal, action, resource) when { -context.a * 2 + 1 - 3 < 0 };",
    )
    .expect("probe parses");
    assert!(has_arithmetic(&probe.to_json().expect("probe json")));
    for p in policies().policies() {
        assert!(
            !has_arithmetic(&p.to_json().expect("policy json")),
            "{} uses arithmetic",
            p.id()
        );
    }
}

#[test]
fn hashes_are_sha256_of_the_file_bytes() {
    let digest = |b: &[u8]| -> [u8; 32] { Sha256::digest(b).into() };
    assert_eq!(policy_set_hash(), digest(POLICY_SET_SRC.as_bytes()));
    assert_eq!(schema_hash(), digest(SCHEMA_SRC.as_bytes()));
    assert_eq!(
        POLICY_SET_SRC.as_bytes(),
        include_bytes!("../policy/keelson.cedar")
    );
    assert_eq!(
        SCHEMA_SRC.as_bytes(),
        include_bytes!("../policy/keelson.cedarschema")
    );
    assert_eq!(
        policy_set_hash_tag(),
        "sha256:76e3a5959eddc084b99b80a7376d85eeb86f005a7ce447420ac67c3e80902123"
    );
    assert_eq!(
        schema_hash_tag(),
        "sha256:3796252b1574d67485d2901c37027334b74bf30de98371b30c7e159558fbc7f9"
    );
}
