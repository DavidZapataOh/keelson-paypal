//! Verifies the deployed leg B: the enclave takes one boot message, and the attestation document it
//! serves binds its signer to a recent Arbitrum Sepolia block.
//!
//! ```sh
//! KEELSON_LIVE=1 TEE_B_URL=https://… KEELSON_TEE_TOKEN=… DSTACK_VERIFIER_URL=http://localhost:8080 \
//!   cargo test -p keelson-tee --features tdx,nitro --test nitro_live -- --ignored --test-threads 1
//! ```
//!
//! `an_unbooted_enclave_takes_one_boot_message` needs an enclave that has not been booted and
//! `KEELSON_BOOT_REQUEST` naming the JSON boot message to send it; run it before the others.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alloy_primitives::{Address, hex};
use aws_nitro_enclaves_nsm_api::api::AttestationDoc;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use keelson_tee::nitro::{Attestation, cose_payload};
use keelson_tee::{chain, report_data};
use serde_json::{Value, json};

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

async fn get(path: &str) -> (u16, Value) {
    let response = chain::http_client()
        .get(format!("{}{path}", env("TEE_B_URL")))
        .send()
        .await
        .unwrap();
    (response.status().as_u16(), response.json().await.unwrap())
}

async fn post(path: &str, token: Option<&str>, body: &Value) -> (u16, Value) {
    let mut request = chain::http_client()
        .post(format!("{}{path}", env("TEE_B_URL")))
        .json(body);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.unwrap();
    (response.status().as_u16(), response.json().await.unwrap())
}

async fn latest_block() -> Value {
    let (number, hash) = chain::latest_block(&chain::rpc_url()).await.unwrap();
    json!({ "number": number, "hash": format!("0x{}", hex::encode(hash)) })
}

#[tokio::test]
#[ignore = "needs an unbooted enclave"]
async fn an_unbooted_enclave_takes_one_boot_message() {
    let request: Value =
        serde_json::from_slice(&std::fs::read(env("KEELSON_BOOT_REQUEST")).unwrap()).unwrap();

    for path in ["/v1/health", "/v1/attestation", "/v1/unknown"] {
        let (status, body) = get(path).await;
        assert_eq!(status, 503, "{path}: {body}");
        assert_eq!(body["code"], "not_ready", "{path}: {body}");
    }
    let (status, body) = post("/v1/countersign", None, &json!({})).await;
    assert_eq!(status, 503, "{body}");

    let (status, booted) = post("/v1/boot", None, &request).await;
    assert_eq!(status, 200, "{booted}");

    let mut other = request.clone();
    other["config"]["bond_vault"] = json!("0x000000000000000000000000000000000000dEaD");
    for second in [&request, &other] {
        let (status, body) = post("/v1/boot", None, second).await;
        assert_eq!(status, 409, "{body}");
        assert_eq!(body["code"], "already_booted", "{body}");
    }

    let (status, health) = get("/v1/health").await;
    assert_eq!(status, 200, "{health}");
    assert_eq!(health["tee"], "nitro");
    assert_eq!(health["signer"], booted["signer"]);
}

/// Checks everything a relying party checks short of the AWS certificate chain, and returns the
/// decoded document.
async fn check(attestation: &Attestation, signer: Address) -> AttestationDoc {
    assert_eq!(attestation.tee, "nitro");
    assert_eq!(attestation.binding.signer, signer);

    let expected = report_data(&attestation.binding, attestation.block.hash.0).unwrap();
    let cose = STANDARD.decode(&attestation.document).unwrap();
    let doc = AttestationDoc::from_binary(&cose_payload(&cose).unwrap()).unwrap();
    assert_eq!(
        doc.user_data.as_ref().map(|b| b.as_slice()),
        Some(&expected[..])
    );
    assert_eq!(
        doc.nonce.as_ref().map(|b| b.as_slice()),
        Some(&attestation.block.hash.0[..]),
        "nonce is the block hash"
    );
    let key = doc
        .public_key
        .as_ref()
        .map(|b| b.as_slice())
        .expect("public_key");
    assert_eq!(key.len(), 65);
    assert_eq!(key[0], 4);
    assert_eq!(Address::from_raw_public_key(&key[1..]), signer);
    assert_eq!(doc.pcrs.len(), 16);
    assert!(
        doc.pcrs[&0].iter().any(|b| *b != 0),
        "PCR0 is all zeros: a debug-mode enclave"
    );

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
    doc
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

#[tokio::test]
#[ignore = "needs the deployed enclave"]
async fn the_attestation_binds_the_signer_to_a_recent_block() {
    let (_, health) = get("/v1/health").await;
    let signer: Address = health["signer"].as_str().unwrap().parse().unwrap();
    let (status, served) = get("/v1/attestation").await;
    assert_eq!(status, 200, "{served}");
    let attestation: Attestation = serde_json::from_value(served).unwrap();
    check(&attestation, signer).await;

    if let Ok(verifier) = std::env::var("DSTACK_VERIFIER_URL") {
        let verified = chain::http_client()
            .post(format!("{verifier}/verify"))
            .json(&json!({
                "attestation": hex::encode(STANDARD.decode(&attestation.document).unwrap()),
                "report_data": hex::encode(
                    report_data(&attestation.binding, attestation.block.hash.0).unwrap()
                ),
            }))
            .send()
            .await
            .unwrap();
        let status = verified.status();
        println!(
            "dstack-verifier: {status} {}",
            verified.text().await.unwrap()
        );
    }
}

#[tokio::test]
#[ignore = "needs the deployed enclave"]
async fn refresh_attests_the_same_signer_over_a_new_block() {
    let token = env("KEELSON_TEE_TOKEN");
    let (_, health) = get("/v1/health").await;
    let signer: Address = health["signer"].as_str().unwrap().parse().unwrap();
    let (_, served) = get("/v1/attestation").await;
    let before: Attestation = serde_json::from_value(served).unwrap();

    let (status, _) = post("/v1/attestation/refresh", None, &json!({})).await;
    assert_eq!(status, 401);

    let block = latest_block().await;
    let (status, refreshed) = post(
        "/v1/attestation/refresh",
        Some(&token),
        &json!({ "block": block }),
    )
    .await;
    assert_eq!(status, 200, "{refreshed}");
    let refreshed: Attestation = serde_json::from_value(refreshed).unwrap();
    assert_eq!(refreshed.binding, before.binding);
    assert!(refreshed.block.number >= before.block.number);
    check(&refreshed, signer).await;

    let (_, served) = get("/v1/attestation").await;
    let served: Attestation = serde_json::from_value(served).unwrap();
    assert_eq!(served.block, refreshed.block);
}
