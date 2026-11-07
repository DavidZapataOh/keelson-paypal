mod common;

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, Response, StatusCode, header};
use common::*;
use http_body_util::BodyExt;
use keelson_tee::server::{AppState, BODY_LIMIT, router};
use keelson_tee::wire::{Countersigned, MandateIssued};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use tower::ServiceExt;

const TOKEN: &str = "k-test-token";

fn clock() -> OffsetDateTime {
    at(NOW + 10)
}

fn app() -> Router {
    let hash = Sha256::digest(TOKEN).into();
    router(Arc::new(AppState::new(leg_a(), hash).with_clock(clock)))
}

fn post(path: &str, token: Option<&str>, body: Vec<u8>) -> Request<Body> {
    let mut req = Request::post(path).header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    req.body(Body::from(body)).unwrap()
}

async fn send(app: &Router, req: Request<Body>) -> (Response<Body>, Vec<u8>) {
    let response = app.clone().oneshot(req).await.unwrap();
    let (parts, body) = response.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes().to_vec();
    (Response::from_parts(parts, Body::empty()), bytes)
}

fn problem(response: &Response<Body>, body: &[u8], status: StatusCode, code: &str) {
    assert_eq!(response.status(), status);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "application/problem+json"
    );
    let p: Value = serde_json::from_slice(body).unwrap();
    assert_eq!(
        p["type"],
        format!("https://keelson.finance/problems/{code}")
    );
    assert_eq!(p["code"], code);
    assert_eq!(p["status"], status.as_u16());
}

#[tokio::test]
async fn health_is_open() {
    let app = app();
    let (response, body) = send(
        &app,
        Request::get("/v1/health").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let health: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(health["tee"], 1);
    assert_eq!(health["boot_epoch"], NOW - 1_000);
    assert_eq!(health["oci_digest"], format!("sha256:{}", "ab".repeat(32)));
    assert_eq!(health["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(health["now_ms"], (NOW + 10) * 1000);
    assert!(health["signer"].as_str().unwrap().starts_with("0x"));
    let issuer = jwk_of(&root().issuer_key());
    assert_eq!(
        health["issuer"],
        json!({ "kty": "EC", "crv": "P-256", "x": issuer.x, "y": issuer.y })
    );
}

#[tokio::test]
async fn refuses_a_missing_or_wrong_bearer() {
    let app = app();
    for token in [None, Some("wrong"), Some("")] {
        for path in ["/v1/countersign", "/v1/mandates/register"] {
            let (response, body) = send(&app, post(path, token, b"{}".to_vec())).await;
            problem(&response, &body, StatusCode::UNAUTHORIZED, "unauthorized");
            assert_eq!(response.headers()[header::WWW_AUTHENTICATE], "Bearer");
        }
    }
    let other_scheme = Request::post("/v1/countersign")
        .header(header::AUTHORIZATION, format!("Basic {TOKEN}"))
        .body(Body::empty())
        .unwrap();
    let (response, body) = send(&app, other_scheme).await;
    problem(&response, &body, StatusCode::UNAUTHORIZED, "unauthorized");
}

#[tokio::test]
async fn refuses_a_body_over_the_limit() {
    let app = app();
    for path in ["/v1/countersign", "/v1/mandates/register"] {
        let big = vec![b' '; BODY_LIMIT + 1];
        let (response, body) = send(&app, post(path, Some(TOKEN), big)).await;
        problem(
            &response,
            &body,
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
        );
    }
}

#[tokio::test]
async fn refuses_an_unknown_field_without_echoing_the_body() {
    let app = app();
    let mut request = serde_json::to_value(register_request()).unwrap();
    request["surprise-field"] = json!("secret-value");
    let (response, body) = send(
        &app,
        post(
            "/v1/mandates/register",
            Some(TOKEN),
            serde_json::to_vec(&request).unwrap(),
        ),
    )
    .await;
    problem(
        &response,
        &body,
        StatusCode::UNPROCESSABLE_ENTITY,
        "bad_request",
    );
    let text = String::from_utf8(body).unwrap();
    assert!(!text.contains("surprise-field") && !text.contains("secret-value"));

    let (response, body) = send(
        &app,
        post("/v1/countersign", Some(TOKEN), b"{not json".to_vec()),
    )
    .await;
    problem(&response, &body, StatusCode::BAD_REQUEST, "bad_request");
}

#[tokio::test]
async fn maps_engine_refusals_to_stable_codes() {
    let app = app();
    let mut r = register_request();
    r.disclosures = vec!["a".to_owned(); 513];
    let (response, body) = send(
        &app,
        post(
            "/v1/mandates/register",
            Some(TOKEN),
            serde_json::to_vec(&r).unwrap(),
        ),
    )
    .await;
    problem(
        &response,
        &body,
        StatusCode::PAYLOAD_TOO_LARGE,
        "payload_too_large",
    );

    let mut r = register_request();
    r.salt = [0; 16];
    let (response, body) = send(
        &app,
        post(
            "/v1/mandates/register",
            Some(TOKEN),
            serde_json::to_vec(&r).unwrap(),
        ),
    )
    .await;
    problem(
        &response,
        &body,
        StatusCode::UNPROCESSABLE_ENTITY,
        "commitment_mismatch",
    );

    let (response, body) = send(
        &app,
        Request::get("/v1/nothing").body(Body::empty()).unwrap(),
    )
    .await;
    problem(&response, &body, StatusCode::NOT_FOUND, "not_found");
}

#[tokio::test]
async fn countersigns_over_http_and_the_signature_recovers_to_the_health_signer() {
    let app = app();
    let (response, body) = send(
        &app,
        post(
            "/v1/mandates/register",
            Some(TOKEN),
            serde_json::to_vec(&register_request()).unwrap(),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let issued: MandateIssued = serde_json::from_slice(&body).unwrap();

    let f = CartFixture::demo();
    let request = countersign_request(&issued, &f, request_id(1), None);
    let bytes = serde_json::to_vec(&request).unwrap();
    let (response, body) = send(&app, post("/v1/countersign", Some(TOKEN), bytes.clone())).await;
    assert_eq!(response.status(), StatusCode::OK);
    let out: Countersigned = serde_json::from_slice(&body).unwrap();
    assert_eq!(out.countersign.decision, "1");

    let (_, health) = send(
        &app,
        Request::get("/v1/health").body(Body::empty()).unwrap(),
    )
    .await;
    let health: Value = serde_json::from_slice(&health).unwrap();
    let signer = health["signer"].as_str().unwrap().to_lowercase();
    assert_eq!(recover(&out).to_string().to_lowercase(), signer);

    // The same bytes get the same answer; the same id with another cart is a replay.
    let (_, again) = send(&app, post("/v1/countersign", Some(TOKEN), bytes)).await;
    assert_eq!(again, body);
    let other = countersign_request(&issued, &CartFixture::sixty(), request_id(1), None);
    let (response, body) = send(
        &app,
        post(
            "/v1/countersign",
            Some(TOKEN),
            serde_json::to_vec(&other).unwrap(),
        ),
    )
    .await;
    problem(&response, &body, StatusCode::CONFLICT, "replay");
}
