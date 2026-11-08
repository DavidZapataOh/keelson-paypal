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
use keelson_tee::Engine;
use keelson_tee::paypal::{PayPalClient, observe, parse};
use keelson_tee::server::{AppState, router};
use keelson_tee::wire::{Countersigned, MandateIssued, PayPalObservation};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

const BIT_PAYPAL: u32 = 1 << 31;

/// A variable that is set and not empty, as an unset repository variable reaches CI.
fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn client() -> Option<PayPalClient> {
    let set = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]
        .iter()
        .all(|v| var(v).is_some());
    set.then(|| PayPalClient::from_env().unwrap())
}

/// The authorization id in `name` and a client, or `None` to skip.
fn sandbox(name: &str) -> Option<(PayPalClient, String)> {
    let id = var(name)?;
    Some((client()?, id))
}

/// Leg A with the demo mandate registered for `payees`.
fn setup(payees: &[&str]) -> (Engine, MandateIssued) {
    leg_a_paying(payees, Arc::default())
}

/// Countersigns `f` on `leg_a` over `read`, and on leg B over leg A's observation.
fn run(
    leg_a: &Engine,
    issued: &MandateIssued,
    f: &CartFixture,
    read: PayPalObservation,
    n: u128,
) -> (Countersigned, Countersigned) {
    countersign_both(leg_a, issued, f, read, request_id(n))
}

fn countersign(
    f: &CartFixture,
    payees: &[&str],
    read: PayPalObservation,
    n: u128,
) -> (Countersigned, Countersigned) {
    let (leg_a, issued) = setup(payees);
    run(&leg_a, &issued, f, read, n)
}

/// `raw` with `edit` applied, as the body PayPal would have sent.
fn edited(raw: &[u8], edit: impl FnOnce(&mut Value)) -> Vec<u8> {
    let mut v: Value = serde_json::from_slice(raw).unwrap();
    edit(&mut v);
    serde_json::to_vec(&v).unwrap()
}

/// The sandbox read of the partially captured fixture and the id it was read for.
async fn captured_read() -> Option<(PayPalObservation, String)> {
    let (client, id) = sandbox("PAYPAL_AUTHORIZATION_PARTIALLY_CAPTURED")?;
    Some((observe(&client, &id).await.unwrap(), id))
}

fn capture(o: &mut Value) -> &mut Value {
    &mut o["purchase_units"][0]["payments"]["captures"][0]
}

fn reparse(
    id: &str,
    read: &PayPalObservation,
    auth: impl FnOnce(&mut Value),
    order: impl FnOnce(&mut Value),
) -> Result<PayPalObservation, keelson_tee::paypal::PayPalError> {
    parse(
        id,
        edited(&read.raw_authorization.0, auth),
        edited(&read.raw_order.0, order),
        read.read_at_ms,
    )
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

#[tokio::test]
async fn every_capture_but_a_failed_one_is_spent() {
    let Some((read, id)) = captured_read().await else {
        return;
    };
    for (status, spent) in [
        ("REFUNDED", 6_000),
        ("PARTIALLY_REFUNDED", 6_000),
        ("PENDING", 6_000),
        ("COMPLETED", 6_000),
        ("SOMETHING_NEW", 6_000),
        ("DECLINED", 0),
        ("FAILED", 0),
    ] {
        let set = |o: &mut Value| {
            o["purchase_units"][0]["payments"]["captures"][0]["status"] = json!(status);
        };
        let r = reparse(&id, &read, |_| {}, set).unwrap();
        assert_eq!(r.captured_minor, spent, "{status}");
    }
}

#[tokio::test]
async fn data_that_does_not_add_up_is_refused() {
    let Some((read, id)) = captured_read().await else {
        return;
    };
    let payee = read.payee_merchant_id.clone();
    // A capture PayPal does not link to an authorization cannot be attributed.
    let unlinked = reparse(&id, &read, |_| {}, |o| capture(o)["links"] = json!([]));
    assert!(unlinked.is_err());
    // No amount is negative.
    let negative = reparse(
        &id,
        &read,
        |_| {},
        |o| {
            capture(o)["amount"]["value"] = json!("-60.00");
        },
    );
    assert!(negative.is_err());
    let negative = reparse(
        &id,
        &read,
        |a| a["amount"]["value"] = json!("-100.00"),
        |_| {},
    );
    assert!(negative.is_err());

    // Partially captured with nothing captured, and more captured than authorized.
    let none = reparse(
        &id,
        &read,
        |_| {},
        |o| capture(o)["status"] = json!("DECLINED"),
    )
    .unwrap();
    let over = reparse(
        &id,
        &read,
        |_| {},
        |o| {
            capture(o)["amount"]["value"] = json!("120.00");
        },
    )
    .unwrap();
    for (read, n) in [(none, 10), (over, 11)] {
        let (a, b) = countersign(&CartFixture::sixty(), &[&payee], read, n);
        for c in [&a, &b] {
            assert_eq!(c.countersign.decision, "2");
            assert_eq!(errors(c), ["paypal.inconsistent"]);
        }
    }
}

#[tokio::test]
async fn an_expired_authorization_is_refused() {
    let Some((read, id)) = captured_read().await else {
        return;
    };
    let payee = read.payee_merchant_id.clone();
    // The status can lag behind the expiry.
    let expired = reparse(
        &id,
        &read,
        |a| {
            a["status"] = json!("CREATED");
            a["expiration_time"] = json!("2026-01-01T00:00:00Z");
        },
        |o| {
            o["purchase_units"][0]["payments"]["captures"] = json!([]);
        },
    )
    .unwrap();
    let (a, b) = countersign(&CartFixture::sixty(), &[&payee], expired, 12);
    for c in [&a, &b] {
        assert_eq!(errors(c), ["paypal.expired"]);
    }
}

#[tokio::test]
async fn one_authorization_holds_a_mandate() {
    let (Some((client, created)), Some(captured)) = (
        sandbox("PAYPAL_AUTHORIZATION_CREATED"),
        var("PAYPAL_AUTHORIZATION_PARTIALLY_CAPTURED"),
    ) else {
        return;
    };
    let first = observe(&client, &created).await.unwrap();
    let second = observe(&client, &captured).await.unwrap();
    let payee = first.payee_merchant_id.clone();
    let (leg_a, issued) = setup(&[&payee]);
    let f = CartFixture::thirty();
    let (a, _) = run(&leg_a, &issued, &f, first.clone(), 13);
    assert_eq!(a.countersign.decision, "1");
    // The same hold again is fine; another authorization of the same mandate is not.
    let (a, _) = run(&leg_a, &issued, &f, first, 14);
    assert_eq!(a.countersign.decision, "1");
    let (a, _) = run(&leg_a, &issued, &f, second, 15);
    assert_eq!(errors(&a), ["paypal.hold_mismatch"]);
}

#[tokio::test]
async fn the_custom_id_must_be_a_sandbox_mandate_hold() {
    let Some((client, id)) = sandbox("PAYPAL_AUTHORIZATION_CREATED") else {
        return;
    };
    let read = observe(&client, &id).await.unwrap();
    let payee = read.payee_merchant_id.clone();
    let mid = "01JBXG3K5N7Q9R2T4V6W8Y0Z1A";
    let digest = "x".repeat(43);
    for (n, custom_id) in [
        format!("ks1.sa.{mid}.{digest}"),
        format!("ks1.pm.{mid}.{digest}"),
        format!("ks1.sm.{mid}.{}", "x".repeat(42)),
        format!("ks2.sm.{mid}.{digest}"),
        format!("ks1.sm.{mid}.{digest}.extra"),
    ]
    .into_iter()
    .enumerate()
    {
        let mut forged = read.clone();
        forged.custom_id = custom_id;
        let (a, _) = countersign(&CartFixture::sixty(), &[&payee], forged, 20 + n as u128);
        assert_eq!(errors(&a), ["paypal.mandate"]);
    }
}

/// Records the sandbox read of the authorization in `env` as `tests/vectors/paypal/<name>.json`
/// when `KEELSON_WRITE_VECTORS=1` and `env` is set. The payer's identity is dropped from the
/// order body; the engine reads none of it.
async fn write_vector(name: &str, env: &str) {
    if var("KEELSON_WRITE_VECTORS").as_deref() != Some("1") {
        return;
    }
    let Some((client, id)) = sandbox(env) else {
        return;
    };
    let read = observe(&client, &id).await.unwrap();
    let mut order: Value = serde_json::from_slice(&read.raw_order.0).unwrap();
    let order_fields = order.as_object_mut().unwrap();
    order_fields.remove("payer");
    order_fields.remove("payment_source");
    let vector = json!({
        "authorization_id": id,
        "read_at_ms": read.read_at_ms,
        "authorization": serde_json::from_slice::<Value>(&read.raw_authorization.0).unwrap(),
        "order": order,
    });
    let path = format!(
        "{}/tests/vectors/paypal/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::write(path, serde_json::to_string_pretty(&vector).unwrap() + "\n").unwrap();
}

#[tokio::test]
async fn write_mandate_hold_vector() {
    write_vector("mandate-hold", "PAYPAL_MANDATE_HOLD").await;
}

#[tokio::test]
async fn write_partially_captured_mandate_hold_vector() {
    write_vector("mandate-hold-captured", "PAYPAL_MANDATE_HOLD_CAPTURED").await;
}

#[tokio::test]
async fn write_other_order_vector() {
    write_vector(
        "mandate-hold-other-order",
        "PAYPAL_MANDATE_HOLD_OTHER_ORDER",
    )
    .await;
}

#[tokio::test]
async fn write_purchase_hold_vector() {
    write_vector("purchase-hold", "PAYPAL_PURCHASE_HOLD").await;
}

#[tokio::test]
#[ignore = "PayPal reauthorizes from day 4 of an authorization: recorded once the mandate-hold authorization has been reauthorized"]
async fn write_reauthorized_mandate_hold_vector() {
    write_vector(
        "mandate-hold-reauthorized",
        "PAYPAL_MANDATE_HOLD_REAUTHORIZED",
    )
    .await;
}
