//! Verifies the deployed leg A: its attestation, checked by `dstack-verifier`, binds the signer it
//! serves to a recent Arbitrum Sepolia block.
//!
//! ```sh
//! KEELSON_LIVE=1 TEE_A_URL=https://… DSTACK_VERIFIER_URL=http://localhost:8080 \
//!   KEELSON_TEE_TOKEN=… cargo test -p keelson-tee --features tdx --test tdx_live -- --ignored
//! ```

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alloy_primitives::{Address, hex};
use keelson_tee::tdx::{Attestation, QUOTE_REPORT_DATA, decode_attestation};
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
