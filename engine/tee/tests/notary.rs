mod common;

use std::sync::Arc;

use alloy_primitives::aliases::U40;
use alloy_primitives::{Address, B256, Signature, keccak256};
use alloy_sol_types::SolStruct;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::*;
use keelson_core::eip712::WebFact;
use keelson_tee::report_data;
use keelson_tee::server::{AppState, router};
use keelson_tee::wire::WebFactSigned;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use tower::ServiceExt;

const TOKEN: &str = "k-test-token";
const STORE: &str = "https://store.keelson.finance/api/products/tempo-3";

fn recover(digest: B256, signature: &[u8; 65]) -> Address {
    Signature::try_from(&signature[..])
        .unwrap()
        .recover_address_from_prehash(&digest)
        .unwrap()
}

fn now() -> OffsetDateTime {
    at(NOW + 10)
}

/// The fact the engine must have signed for a session it accepted at `t`.
fn expected(
    signed: &WebFactSigned,
    binding: &[u8; 64],
    host: &str,
    target: &str,
    commitment: [u8; 32],
    t: i64,
) {
    let fact = WebFact {
        hostHash: keccak256(host),
        urlPathHash: keccak256(target),
        tCapture: U40::from(t as u64),
        rangeCommitment: B256::new(commitment),
        attId: B256::from_slice(&binding[..32]),
    };
    let domain = keelson_core::domain(421_614, Address::ZERO).unwrap();
    let digest = fact.eip712_signing_hash(&domain);
    assert_eq!(signed.digest.0, digest.0);
    assert_eq!(signed.web_fact.host_hash.0, fact.hostHash.0);
    assert_eq!(signed.web_fact.url_path_hash.0, fact.urlPathHash.0);
    assert_eq!(signed.web_fact.t_capture, t);
    assert_eq!(signed.web_fact.range_commitment.0, commitment);
    assert_eq!(signed.web_fact.att_id.0, fact.attId.0);
    assert_eq!(signed.chain_id, 421_614);
    assert_eq!(recover(digest, &signed.signature.0), signed.signer);
}

#[test]
fn signs_a_web_fact_bound_to_its_attestation() {
    let engine = leg_a();
    let commitment = [7; 32];
    let signed = engine
        .sign_web_fact(
            "store.keelson.finance",
            "/api/products/tempo-3",
            commitment,
            now(),
        )
        .unwrap();
    assert_eq!(signed.signer, engine.signer());
    expected(
        &signed,
        &binding(&engine),
        "store.keelson.finance",
        "/api/products/tempo-3",
        commitment,
        NOW + 10,
    );
}

fn binding(engine: &keelson_tee::Engine) -> [u8; 64] {
    report_data(&engine.binding().unwrap(), [0; 32]).unwrap()
}

fn app() -> axum::Router {
    app_with(leg_a())
}

fn app_with(engine: keelson_tee::Engine) -> axum::Router {
    let state = AppState::new(engine, Sha256::digest(TOKEN).into())
        .with_clock(now)
        .with_notary();
    router(Arc::new(state))
}

fn notary_request(token: Option<&str>, upgrade: Option<&str>) -> Request<Body> {
    let mut r = Request::get("/v1/notary");
    if let Some(token) = token {
        r = r.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if let Some(upgrade) = upgrade {
        r = r
            .header(header::CONNECTION, "upgrade")
            .header(header::UPGRADE, upgrade);
    }
    r.body(Body::empty()).unwrap()
}

#[tokio::test]
async fn the_notary_needs_the_bearer_and_its_upgrade() {
    let app = app();
    let r = app
        .clone()
        .oneshot(notary_request(None, Some("keelson-notary")))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    let r = app
        .clone()
        .oneshot(notary_request(Some(TOKEN), None))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    let r = app
        .clone()
        .oneshot(notary_request(Some(TOKEN), Some("websocket")))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_leg_without_a_notary_does_not_route_it() {
    let app = router(Arc::new(AppState::new(
        leg_a(),
        Sha256::digest(TOKEN).into(),
    )));
    let r = app
        .oneshot(notary_request(Some(TOKEN), Some("keelson-notary")))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
}

/// The whole path over HTTP: the prover upgrades `GET /v1/notary`, runs MPC-TLS against the demo
/// store with the engine as the other party, and gets back the `WebFact` the engine signed.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "live: reaches the demo store"]
async fn notarizes_the_demo_store_over_http_and_signs_its_web_fact() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let engine = leg_a();
    let bound = binding(&engine);
    tokio::spawn(async move { axum::serve(listener, app_with(engine)).await.unwrap() });

    let io = keelson_tlsn::notary::connect(&base, TOKEN).await.unwrap();
    let (proven, io) = keelson_tlsn::prove(io, STORE, Some(r#""sku""#), keelson_tlsn::Mode::Mpc)
        .await
        .unwrap();
    let answer = keelson_tlsn::notary::answer(io).await.unwrap();
    let signed: WebFactSigned = serde_json::from_value(answer).unwrap();
    expected(
        &signed,
        &bound,
        "store.keelson.finance",
        "/api/products/tempo-3",
        proven.commitment,
        NOW + 10,
    );
}
