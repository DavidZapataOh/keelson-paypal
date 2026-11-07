//! Leg A reads the PayPal sandbox: authorizations created by
//! `packages/paypal/test/sandbox/authorization-states.ts`, whose ids are in
//! `PAYPAL_AUTHORIZATION_CREATED`, `PAYPAL_AUTHORIZATION_PARTIALLY_CAPTURED` and
//! `PAYPAL_AUTHORIZATION_VOIDED`, next to `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`. Each
//! test is skipped when the variables it needs are not set.

mod common;

use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::*;
use http_body_util::BodyExt;
use keelson_tee::paypal::{PayPalClient, observe};
use keelson_tee::server::{AppState, router};
use keelson_tee::wire::{Countersigned, PayPalObservation};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

const BIT_PAYPAL: u32 = 1 << 31;

fn client() -> Option<PayPalClient> {
    let set = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]
        .iter()
        .all(|v| std::env::var(v).is_ok());
    set.then(|| PayPalClient::from_env().unwrap())
}

/// The authorization id in `name` and a client, or `None` to skip.
fn sandbox(name: &str) -> Option<(PayPalClient, String)> {
    let id = std::env::var(name).ok()?;
    Some((client()?, id))
}

/// Registers the demo mandate with `payees` and countersigns `f` on leg A over `read`.
fn countersign(
    f: &CartFixture,
    payees: &[&str],
    read: PayPalObservation,
    n: u128,
) -> (Countersigned, Countersigned) {
    let leg_a = leg_a();
    let allowed: Vec<Value> = payees
        .iter()
        .map(|p| json!({ "paypal_merchant_id": p }))
        .collect();
    let register = mandate_with(&sub(), &other_passkey(), |m| {
        let payees = m["payment"]["constraints"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|c| c["type"] == "payment.allowed_payees")
            .unwrap();
        payees["allowed"] = json!(allowed);
    });
    let issued = leg_a.register_mandate(&register, at(NOW)).unwrap();
    let r = countersign_request(&issued, f, request_id(n), None);
    let a = leg_a
        .countersign_with(&r, at(NOW + 10), Some(read))
        .unwrap();
    // Leg B signs the same decision over leg A's observation, PayPal included.
    let r = countersign_request(&issued, f, request_id(n), Some(a.observation.clone()));
    let b = leg_b().countersign(&r, at(NOW + 10)).unwrap();
    (a, b)
}

fn errors(c: &Countersigned) -> Vec<String> {
    trace(c)["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e.as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn a_fresh_authorization_backs_the_cart() {
    let Some((client, id)) = sandbox("PAYPAL_AUTHORIZATION_CREATED") else {
        return;
    };
    let read = observe(&client, &id).await.unwrap();
    assert_eq!(read.status, "CREATED");
    assert_eq!((read.authorized_minor, read.captured_minor), (10_000, 0));
    let payee = read.payee_merchant_id.clone();
    let (a, b) = countersign(&CartFixture::sixty(), &[&payee], read, 1);
    for c in [&a, &b] {
        assert_eq!(c.countersign.decision, "1", "{:?}", errors(c));
        assert_eq!(mask(c), 0);
    }
    assert_eq!(a.observation.budget_left_minor, 10_000);
    assert_eq!(a.observation.paypal.authorization_id, id);
}

#[tokio::test]
async fn a_capture_is_spent() {
    let Some((client, id)) = sandbox("PAYPAL_AUTHORIZATION_PARTIALLY_CAPTURED") else {
        return;
    };
    let read = observe(&client, &id).await.unwrap();
    assert_eq!(read.status, "PARTIALLY_CAPTURED");
    assert_eq!(
        (read.authorized_minor, read.captured_minor),
        (10_000, 6_000)
    );
    let payee = read.payee_merchant_id.clone();
    let (a, b) = countersign(&CartFixture::sixty(), &[&payee], read, 2);
    for c in [&a, &b] {
        assert_eq!(c.countersign.decision, "2");
        assert_eq!(mask(c) & BIT_PAYPAL, BIT_PAYPAL);
        assert_eq!(errors(c), ["paypal.insufficient"]);
    }
    assert_eq!(a.observation.budget_left_minor, 4_000);
}

#[tokio::test]
async fn a_voided_authorization_is_refused() {
    let Some((client, id)) = sandbox("PAYPAL_AUTHORIZATION_VOIDED") else {
        return;
    };
    let read = observe(&client, &id).await.unwrap();
    assert_eq!(read.status, "VOIDED");
    let payee = read.payee_merchant_id.clone();
    let (a, _) = countersign(&CartFixture::sixty(), &[&payee], read, 3);
    assert_eq!(a.countersign.decision, "2");
    assert_eq!(mask(&a) & BIT_PAYPAL, BIT_PAYPAL);
    assert_eq!(errors(&a), ["paypal.status"]);
}

#[tokio::test]
async fn a_payee_outside_the_mandate_is_refused() {
    let Some((client, id)) = sandbox("PAYPAL_AUTHORIZATION_CREATED") else {
        return;
    };
    let read = observe(&client, &id).await.unwrap();
    let (a, b) = countersign(&CartFixture::sixty(), &["NOTTHEPAYEE1"], read, 4);
    for c in [&a, &b] {
        assert_eq!(c.countersign.decision, "2");
        assert_eq!(errors(c), ["paypal.payee"]);
    }
}

#[tokio::test]
async fn a_hold_of_another_mandate_is_refused() {
    let Some((client, id)) = sandbox("PAYPAL_AUTHORIZATION_CREATED") else {
        return;
    };
    let mut read = observe(&client, &id).await.unwrap();
    let payee = read.payee_merchant_id.clone();
    read.custom_id = read
        .custom_id
        .replace("01JBXG3K5N7Q9R2T4V6W8Y0Z1A", "01JBXG3K5N7Q9R2T4V6W8Y0Z1B");
    let (a, _) = countersign(&CartFixture::sixty(), &[&payee], read, 5);
    assert_eq!(errors(&a), ["paypal.mandate"]);
}

#[tokio::test]
async fn an_unreachable_paypal_signs_nothing() {
    let client = PayPalClient::new("http://127.0.0.1:9", "id", "secret");
    assert!(observe(&client, "5KR28355PH2745516").await.is_err());
    assert!(observe(&client, "../orders").await.is_err());

    let token = "k-test-token";
    let state = AppState::new(leg_a(), Sha256::digest(token).into())
        .with_clock(|| at(NOW + 10))
        .with_paypal(client);
    let issued = register();
    let mut r = countersign_request(&issued, &CartFixture::sixty(), request_id(6), None);
    r.authorization_id = Some("5KR28355PH2745516".into());
    let response = router(Arc::new(state))
        .oneshot(
            Request::post("/v1/countersign")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::from(serde_json::to_vec(&r).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let problem: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(problem["code"], "paypal");
    assert!(problem.get("countersign").is_none());
}

/// `cargo test -p keelson-tee --features tdx --test paypal_sandbox -- --ignored --nocapture`
#[tokio::test]
#[ignore = "measures the sandbox"]
async fn paypal_read_latency() {
    let Some((client, id)) = sandbox("PAYPAL_AUTHORIZATION_PARTIALLY_CAPTURED") else {
        return;
    };
    observe(&client, &id).await.unwrap();
    let mut ms = Vec::new();
    for _ in 0..50 {
        let started = Instant::now();
        observe(&client, &id).await.unwrap();
        ms.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    ms.sort_by(f64::total_cmp);
    println!(
        "paypal read (two GETs, warm token): p50 {:.0} ms, p95 {:.0} ms",
        ms[24], ms[47]
    );
}
