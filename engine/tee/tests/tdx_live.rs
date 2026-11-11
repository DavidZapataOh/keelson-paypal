//! Verifies the deployed leg A: its attestation, checked by `dstack-verifier`, binds the signer it
//! serves to a recent Arbitrum Sepolia block.
//!
//! ```sh
//! KEELSON_LIVE=1 TEE_A_URL=https://… DSTACK_VERIFIER_URL=http://localhost:8080 \
//!   KEELSON_TEE_TOKEN=… cargo test -p keelson-tee --features tdx --test tdx_live -- --ignored
//! ```
//!
//! `registrations_survive_a_redeploy` runs twice, on either side of a restart or redeploy of the
//! CVM, with `KEELSON_LIVE_STATE` naming a file that the first run writes and the second reads.

mod common;

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alloy_primitives::{Address, hex};
use keelson_tee::tdx::{Attestation, QUOTE_REPORT_DATA, decode_attestation};
use keelson_tee::wire::{Countersigned, MandateIssued, RegisterMandate};
use keelson_tee::{chain, report_data};
use serde_json::{Value, json};

use common::{CartFixture, close, countersign_request, mandate_on, other_passkey, seed};

/// The origin the deployed engine accepts passkey assertions on.
const ORIGIN: &str = "https://app.keelson.finance";
const SUB: &str = "kls_usr_live_redeploy";

/// The oldest block an attestation may name.
const MAX_BLOCK_AGE: Duration = Duration::from_secs(3_600);

fn env(name: &str) -> String {
    assert_eq!(
        std::env::var("KEELSON_LIVE").as_deref(),
        Ok("1"),
        "set KEELSON_LIVE=1"
    );
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"))
}

async fn get(url: &str) -> Value {
    chain::http_client()
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn rpc(method: &str, params: Value) -> Value {
    let response: Value = chain::http_client()
        .post(chain::rpc_url())
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    response["result"].clone()
}

/// Checks everything a relying party checks, and returns the verifier's details.
async fn check(attestation: &Attestation, signer: Address) -> Value {
    assert_eq!(attestation.tee, "tdx");
    assert_eq!(attestation.binding.signer, signer);

    let expected = report_data(&attestation.binding, attestation.block.hash.0).unwrap();
    let evidence = decode_attestation(&hex::decode(&attestation.attestation).unwrap()).unwrap();
    assert_eq!(evidence.report_data, expected);
    assert_eq!(hex::encode(&evidence.quote), attestation.quote);
    assert_eq!(evidence.quote[QUOTE_REPORT_DATA], expected);

    let block = rpc(
        "eth_getBlockByNumber",
        json!([format!("{:#x}", attestation.block.number), false]),
    )
    .await;
    assert_eq!(block["hash"], attestation.block.hash.to_string());
    let timestamp = u64::from_str_radix(
        block["timestamp"]
            .as_str()
            .unwrap()
            .trim_start_matches("0x"),
        16,
    )
    .unwrap();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    assert!(
        now.as_secs() - timestamp < MAX_BLOCK_AGE.as_secs(),
        "block {} is older than an hour",
        attestation.block.number
    );

    let verified: Value = chain::http_client()
        .post(format!("{}/verify", env("DSTACK_VERIFIER_URL")))
        .json(&json!({ "attestation": attestation.attestation }))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(verified["is_valid"], true, "{verified}");
    let details = &verified["details"];
    assert_eq!(details["report_data"], hex::encode(expected));
    assert_eq!(details["app_info"]["app_id"], attestation.app_id);
    assert_eq!(
        details["app_info"]["compose_hash"],
        attestation.compose_hash
    );
    details.clone()
}

#[tokio::test]
#[ignore = "needs the deployed CVM"]
async fn the_attestation_binds_the_signer_to_a_recent_block() {
    let url = env("TEE_A_URL");
    let health = get(&format!("{url}/v1/health")).await;
    let attestation: Attestation =
        serde_json::from_value(get(&format!("{url}/v1/attestation")).await).unwrap();
    let signer: Address = health["signer"].as_str().unwrap().parse().unwrap();
    let details = check(&attestation, signer).await;
    println!(
        "dstack {} tcb {} {}",
        attestation.dstack_version, details["tcb_status"], details["advisory_ids"]
    );
}

#[tokio::test]
#[ignore = "needs the deployed CVM"]
async fn refresh_reattests_the_same_signer_over_a_new_block() {
    let url = env("TEE_A_URL");
    let before: Attestation =
        serde_json::from_value(get(&format!("{url}/v1/attestation")).await).unwrap();
    let refreshed: Attestation = chain::http_client()
        .post(format!("{url}/v1/attestation/refresh"))
        .bearer_auth(env("KEELSON_TEE_TOKEN"))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(refreshed.binding, before.binding);
    assert!(refreshed.block.number >= before.block.number);
    check(&refreshed, before.binding.signer).await;
    let served: Attestation =
        serde_json::from_value(get(&format!("{url}/v1/attestation")).await).unwrap();
    assert!(served.block.number >= refreshed.block.number);
}

async fn register(url: &str, request: &RegisterMandate) -> (u16, Value) {
    let response = chain::http_client()
        .post(format!("{url}/v1/mandates/register"))
        .bearer_auth(env("KEELSON_TEE_TOKEN"))
        .json(request)
        .send()
        .await
        .unwrap();
    (response.status().as_u16(), response.json().await.unwrap())
}

fn mandate(passkey: &p256::ecdsa::SigningKey) -> RegisterMandate {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    mandate_on(ORIGIN, SUB, passkey, |m| {
        m["nbf"] = json!(now - 60);
        m["exp"] = json!(now + 7 * 86_400);
    })
}

/// The first run registers a mandate. After a restart or redeploy of the same app, the second
/// presents the credential issued before it, which only the same root can have signed. Another
/// passkey of the same user registers with a user credential of its own.
#[tokio::test]
#[ignore = "needs the deployed CVM and KEELSON_LIVE_STATE"]
async fn registrations_survive_a_redeploy() {
    let url = env("TEE_A_URL");
    let state = PathBuf::from(env("KEELSON_LIVE_STATE"));
    let passkey = p256::ecdsa::SigningKey::from_slice(&seed("key/live")).unwrap();

    let (request, issued) = match std::fs::read(&state) {
        Err(_) => {
            let request = mandate(&passkey);
            let (status, body) = register(&url, &request).await;
            assert_eq!(status, 200, "{body}");
            let issued: MandateIssued = serde_json::from_value(body).unwrap();
            std::fs::write(
                &state,
                serde_json::to_vec(&json!({ "request": request, "issued": issued })).unwrap(),
            )
            .unwrap();
            (request, issued)
        }
        Ok(saved) => {
            let saved: Value = serde_json::from_slice(&saved).unwrap();
            let mut request: RegisterMandate =
                serde_json::from_value(saved["request"].clone()).unwrap();
            let before: MandateIssued = serde_json::from_value(saved["issued"].clone()).unwrap();
            request.user_credential = Some(before.user_credential.clone());
            let (status, body) = register(&url, &request).await;
            assert_eq!(status, 200, "{body}");
            let after: MandateIssued = serde_json::from_value(body).unwrap();
            assert_eq!(after.user_credential, before.user_credential);
            (request, after)
        }
    };
    assert_eq!(request.sub, SUB);
    assert!(!issued.user_credential.is_empty());

    let (status, body) = register(&url, &mandate(&other_passkey())).await;
    assert_eq!(status, 200, "{body}");
    let other: MandateIssued = serde_json::from_value(body).unwrap();
    assert_ne!(other.user_credential, issued.user_credential);
}

/// Countersigns carts against a real sandbox authorization, so every request makes the engine read
/// PayPal from inside the CVM, and prints the round trip.
#[tokio::test]
#[ignore = "needs the deployed CVM and PAYPAL_AUTHORIZATION_CREATED"]
async fn paypal_is_read_from_inside_the_cvm() {
    let url = env("TEE_A_URL");
    let authorization = env("PAYPAL_AUTHORIZATION_CREATED");
    let passkey = p256::ecdsa::SigningKey::from_slice(&seed("key/live")).unwrap();
    let (status, body) = register(&url, &mandate(&passkey)).await;
    assert_eq!(status, 200, "{body}");
    let issued: MandateIssued = serde_json::from_value(body).unwrap();

    let cart = CartFixture::demo();
    let mut millis = Vec::new();
    for _ in 0..20 {
        let id = ulid::Ulid::generate();
        let mut request = countersign_request(&issued, &cart, id, None);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        request.closed_mandate = close(
            &issued.open_mandate,
            &id.to_string(),
            &cart.hash(),
            now as i64,
        );
        request.sub = SUB.into();
        request.authorization_id = Some(authorization.clone());

        let started = std::time::Instant::now();
        let response = chain::http_client()
            .post(format!("{url}/v1/countersign"))
            .bearer_auth(env("KEELSON_TEE_TOKEN"))
            .json(&request)
            .send()
            .await
            .unwrap();
        millis.push(started.elapsed().as_millis());
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap();
        assert_eq!(status, 200, "{body}");
        let signed: Countersigned = serde_json::from_value(body).unwrap();
        assert_eq!(signed.observation.paypal.status, "CREATED");
    }
    millis.sort_unstable();
    println!(
        "countersign with the PayPal read: p50 {} ms, p95 {} ms",
        millis[millis.len() / 2],
        millis[millis.len() * 95 / 100]
    );
}
