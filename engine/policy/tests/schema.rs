use std::collections::BTreeSet;

use cedar_policy::{Effect, Entities, PolicyId, ValidationMode, Validator};
use keelson_policy::{
    POLICY_SET_SRC, SCHEMA_SRC, mandate_agent, mandate_entity, policies, policy_set_hash,
    policy_set_hash_tag, policy_texts, schema, schema_hash, schema_hash_tag,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const POLICY_IDS: [&str; 12] = [
    "agent", "amount", "base", "budget", "category", "currency", "merchant", "quantity", "returns",
    "sanity", "variant", "window",
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
                "not_before": { "__extn": { "fn": "datetime", "arg": "2026-11-04T00:00:00.000Z" } },
                "expires_at": { "__extn": { "fn": "datetime", "arg": "2026-11-11T00:00:00.000Z" } },
                "min_return_days": 30
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
    assert_eq!(
        attrs["attrs"]["expires_at"]["__extn"]["arg"],
        "2026-11-05T12:00:00.001Z"
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
        "sha256:af6703bc629b02c95059ecd30710497b7d5688fe0ce24895af38375730593cc5"
    );
    assert_eq!(
        schema_hash_tag(),
        "sha256:ea0d509820ca7f302463b526f4d5aba1c347aae5d1f5ca98aad05dc5aa2199ac"
    );
}
