//! Leg A pieces that run off the CVM: the attestation decoder over evidence captured on Intel TDX,
//! the Arbitrum Sepolia RPC, and the attestation routes.
//!
//! `fixtures/dstack-v1-attest.json` is a `POST /v1/Attest` response captured on Intel TDX
//! hardware by the dstack project (`dstack/verifier/fixtures/tdx-lite-v1-attest.json` at v0.6.1,
//! Apache-2.0), over 64 bytes of `0x42`.

mod common;

use std::sync::Arc;

use alloy_primitives::hex;
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::*;
use http_body_util::BodyExt;
use keelson_tee::chain;
use keelson_tee::server::{AppState, router};
use keelson_tee::tdx::{
    Attestation, Block, Dstack, DstackError, QUOTE_REPORT_DATA, decode_attestation,
};
use keelson_tee::wire::Hex;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tower::ServiceExt;

const TOKEN: &str = "k-test-token";

fn captured() -> Vec<u8> {
    let response: Value =
        serde_json::from_str(include_str!("fixtures/dstack-v1-attest.json")).unwrap();
    hex::decode(response["attestation"].as_str().unwrap()).unwrap()
}

#[test]
fn decodes_a_v1_attestation_from_tdx_hardware() {
    let evidence = decode_attestation(&captured()).unwrap();
    assert_eq!(evidence.report_data, [0x42; 64]);
    assert_eq!(&evidence.quote[..2], [4, 0], "TDX quote v4");
    assert_eq!(evidence.quote[QUOTE_REPORT_DATA], [0x42; 64]);
    let log = evidence.event_log.as_array().unwrap();
    assert!(!log.is_empty());
    for event in log {
        let imr = event["imr"].as_u64().unwrap();
        assert!(imr <= 3);
        assert!(event["event_type"].is_u64());
        let digest = event["digest"].as_str().unwrap();
        assert_eq!(hex::decode(digest).unwrap().len(), 48, "sha384");
        assert!(event["event"].is_string());
        assert!(event["event_payload"].is_string());
    }
    let names: Vec<_> = log
        .iter()
        .filter(|e| e["imr"] == 3)
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"compose-hash"), "{names:?}");
    assert!(names.contains(&"app-id"), "{names:?}");
}

#[test]
fn refuses_what_is_not_a_v1_attestation() {
    let bytes = captured();
    let mut trailing = bytes.clone();
    trailing.push(0);
    for bad in [
        &[][..],
        &bytes[..bytes.len() - 1],
        &trailing,
        // The legacy SCALE form starts with 0x00.
        &[0, 0, 0x49, 0x4e][..],
    ] {
        assert!(matches!(
            decode_attestation(bad),
            Err(DstackError::Malformed(_))
        ));
    }
}

#[tokio::test]
async fn an_absent_agent_is_a_transport_error() {
    let dstack = Dstack::new("/nonexistent/dstack.sock");
    assert!(matches!(
        dstack.root().await,
        Err(DstackError::Transport(_))
    ));
}

#[tokio::test]
async fn reads_the_latest_arbitrum_sepolia_block() {
    let rpc = chain::rpc_url();
    assert_eq!(chain::chain_id(&rpc).await.unwrap(), 421_614);
    let (first, hash) = chain::latest_block(&rpc).await.unwrap();
    assert_ne!(hash, [0; 32]);
    let (second, _) = chain::latest_block(&rpc).await.unwrap();
    assert!(first > 0 && second >= first);
}

#[tokio::test]
async fn an_rpc_that_does_not_answer_is_an_error() {
    assert!(matches!(
        chain::latest_block("http://127.0.0.1:9").await,
        Err(chain::ChainError::Http(_))
    ));
}

/// Leg A serving the evidence captured on hardware. Its quote binds other report data than this
/// engine's, which the routes neither check nor need.
fn app() -> (Router, Attestation) {
    let engine = leg_a();
    let bytes = captured();
    let evidence = decode_attestation(&bytes).unwrap();
    let binding = engine.binding().unwrap();
    let attestation = Attestation {
        tee: "tdx".into(),
        attestation: hex::encode(&bytes),
        quote: hex::encode(&evidence.quote),
        event_log: evidence.event_log,
        binding,
        block: Block {
            number: 1,
            hash: Hex([0x42; 32]),
        },
        app_id: "00".repeat(20),
        compose_hash: "00".repeat(32),
        dstack_version: "0.6.1".into(),
    };
    let state =
        AppState::new(engine, Sha256::digest(TOKEN).into()).with_attestation(attestation.clone());
    (router(Arc::new(state)), attestation)
}

async fn send(app: &Router, req: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&body).unwrap())
}

#[tokio::test]
async fn serves_the_attestation_without_a_bearer() {
    let (app, attestation) = app();
    let (status, body) = send(
        &app,
        Request::get("/v1/attestation").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, serde_json::to_value(&attestation).unwrap());
    let served: Attestation = serde_json::from_value(body).unwrap();
    assert_eq!(served, attestation);
}

#[tokio::test]
async fn refresh_needs_the_bearer_and_the_agent() {
    let (app, _) = app();
    let refresh = |token: Option<&str>| {
        let mut req = Request::post("/v1/attestation/refresh");
        if let Some(token) = token {
            req = req.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        req.body(Body::empty()).unwrap()
    };
    let (status, body) = send(&app, refresh(None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["code"], "unauthorized");
    // SAFETY: no other test in this binary reads the variable.
    unsafe { std::env::set_var("DSTACK_SIMULATOR_ENDPOINT", "/nonexistent/dstack.sock") };
    let (status, body) = send(&app, refresh(Some(TOKEN))).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body["code"], "attestation");
}

#[tokio::test]
async fn without_an_attestation_there_are_no_attestation_routes() {
    let app = router(Arc::new(AppState::new(
        leg_a(),
        Sha256::digest(TOKEN).into(),
    )));
    let (status, body) = send(
        &app,
        Request::get("/v1/attestation").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "not_found");
}
