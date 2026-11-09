mod common;

use std::sync::Arc;

use alloy_primitives::{Address, B256, Signature, U256};
use alloy_sol_types::SolStruct;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::*;
use http_body_util::BodyExt;
use keelson_policy::{Facts, NO_FIELD, VerdictInput, verdict};
use keelson_tee::server::{AppState, router};
use keelson_tee::wire::VerdictSigned;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use tower::ServiceExt;

const TOKEN: &str = "k-test-token";
const DISPUTE: &str = "PP-D-27803";
const COVERAGE: &str = "0x0000000000000000000000000000000001f3b9c6a0e3b6c0a6f0b9d8e7c6b5a4";
const PAYEE: &str = "0x467d2bebb479d9b80ab1c461243e05a2b82387d8";
const EVIDENCE: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const ROOT: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";

fn now() -> OffsetDateTime {
    at(NOW)
}

/// R61: the amber field failed on a dispute the user calls unauthorised.
fn amber() -> Value {
    json!({
        "reason": "UNAUTHORISED",
        "proof_valid": true,
        "failed_green": false,
        "failed_amber": true,
        "failed_gray": false,
        "captured_eq_countersigned": true,
        "duplicate_countersig": false,
        "duplicate_capture": false,
        "tracking_delivered": false,
        "snapshot_matches_item": true,
        "refund_recorded": false,
    })
}

fn input(failed_fields: Value) -> Value {
    json!({
        "paypal_dispute_id": DISPUTE,
        "coverage_id": COVERAGE,
        "agent_id": "7",
        "payee": PAYEE,
        "amount": "42000000",
        "failed_fields": failed_fields,
        "evidence_hash": EVIDENCE,
        "checkpoint_root": ROOT,
        "issued_at": NOW,
        "deadline": NOW + 86_400,
    })
}

fn recover(digest: B256, signature: &[u8; 65]) -> Address {
    Signature::try_from(&signature[..])
        .unwrap()
        .recover_address_from_prehash(&digest)
        .unwrap()
}

async fn post(body: Value, token: Option<&str>, leg: keelson_tee::Engine) -> (StatusCode, Value) {
    let app = router(Arc::new(
        AppState::new(leg, Sha256::digest(TOKEN).into()).with_clock(now),
    ));
    let mut req = Request::post("/v1/verdict").header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let response = app
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn a_leg_attributes_and_signs_the_verdict() {
    let body = json!({ "facts": amber(), "input": input(json!({ "amber": 9, "gray": 10 })) });
    let (status, out) = post(body, Some(TOKEN), leg_a()).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    let signed: VerdictSigned = serde_json::from_value(out).unwrap();

    let facts: Facts = serde_json::from_value(amber()).unwrap();
    let expected = verdict(
        &facts,
        &VerdictInput {
            paypal_dispute_id: DISPUTE,
            coverage_id: COVERAGE.parse().unwrap(),
            agent_id: U256::from(7),
            payee: PAYEE.parse().unwrap(),
            amount: 42_000_000,
            field_id: 9,
            evidence_hash: EVIDENCE.parse().unwrap(),
            checkpoint_root: ROOT.parse().unwrap(),
            issued_at: NOW as u64,
            deadline: NOW as u64 + 86_400,
        },
    )
    .unwrap();
    let domain = keelson_core::domain(421_614, Address::ZERO).unwrap();
    let digest = expected.eip712_signing_hash(&domain);

    assert_eq!(signed.digest.0, digest.0);
    assert_eq!(signed.verdict.rule_id, "61");
    assert_eq!(signed.verdict.liable, "1");
    assert_eq!(signed.verdict.field_id, "9");
    assert_eq!(signed.verdict.dispute_id.0, expected.disputeId.0);
    assert_eq!(signed.chain_id, 421_614);
    assert_eq!(recover(digest, &signed.signature.0), signed.signer);
}

#[tokio::test]
async fn both_legs_sign_the_same_digest() {
    let body = json!({ "facts": amber(), "input": input(json!({ "amber": 9, "gray": 10 })) });
    let (_, a) = post(body.clone(), Some(TOKEN), leg_a()).await;
    let (status, b) = post(body, Some(TOKEN), leg_b()).await;
    assert_eq!(status, StatusCode::OK, "{b}");
    assert_eq!(a["digest"], b["digest"]);
    assert_ne!(a["signer"], b["signer"]);
}

#[tokio::test]
async fn a_field_rule_needs_a_field_of_its_color() {
    let body = json!({ "facts": amber(), "input": input(json!({ "green": 3 })) });
    let (status, out) = post(body, Some(TOKEN), leg_a()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(out["code"], "bad_request");
}

#[tokio::test]
async fn unknown_fields_and_missing_tokens_are_refused() {
    let mut facts = amber();
    facts["liable"] = json!(4);
    let (status, _) = post(
        json!({ "facts": facts, "input": input(json!({ "amber": 9, "gray": 10 })) }),
        Some(TOKEN),
        leg_a(),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let (status, out) = post(
        json!({ "facts": amber(), "input": input(json!({ "amber": 9, "gray": 10 })) }),
        None,
        leg_a(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(out["code"], "unauthorized");
}

#[tokio::test]
async fn a_rule_about_no_field_names_none() {
    let mut facts = amber();
    facts["proof_valid"] = json!(false);
    let body = json!({ "facts": facts, "input": input(json!({ "amber": 9 })) });
    let (status, out) = post(body, Some(TOKEN), leg_a()).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["verdict"]["ruleId"], "0");
    assert_eq!(out["verdict"]["fieldId"], NO_FIELD.to_string());
}
