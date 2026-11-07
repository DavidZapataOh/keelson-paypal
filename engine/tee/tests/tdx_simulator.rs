//! Boots leg A against the official dstack guest agent simulator and the Arbitrum Sepolia RPC.
//!
//! The simulator serves the real guest agent API and key derivation from its `appkeys.json`; its
//! quote is a captured one with the report data written in, so these tests check what the engine
//! asks for and binds, never that the quote verifies. Run with `DSTACK_SIMULATOR_ENDPOINT` set to
//! the simulator's `dstack.sock`, next to which it keeps `appkeys.json`:
//!
//! ```sh
//! cargo test -p keelson-tee --features tdx --test tdx_simulator -- --ignored
//! ```

mod common;

use std::path::Path;

use alloy_primitives::hex;
use common::*;
use hkdf::Hkdf;
use keelson_tee::server::{self, AppState};
use keelson_tee::tdx::{self, Dstack, QUOTE_REPORT_DATA, ROOT_DOMAIN, decode_attestation};
use keelson_tee::{Root, chain, report_data};
use serde_json::Value;
use sha2::Sha256;
use time::OffsetDateTime;

fn endpoint() -> String {
    std::env::var("DSTACK_SIMULATOR_ENDPOINT").expect("DSTACK_SIMULATOR_ENDPOINT is set")
}

/// `LP(x) = uint32_be(len(x)) ‖ x`.
fn lp(out: &mut Vec<u8>, x: &[u8]) {
    out.extend_from_slice(&u32::try_from(x.len()).unwrap().to_be_bytes());
    out.extend_from_slice(x);
}

/// The dstack guest API v1 key: HKDF-SHA256 with salt `dstack-guest-v1` over the app's root
/// secp256k1 key and `LP("dstack-guest-v1-key") ‖ LP(algorithm) ‖ LP(domain)`.
fn v1_key(app_key: &[u8], algorithm: &str, domain: &str) -> [u8; 32] {
    let mut info = Vec::new();
    lp(&mut info, b"dstack-guest-v1-key");
    lp(&mut info, algorithm.as_bytes());
    lp(&mut info, domain.as_bytes());
    let mut key = [0; 32];
    Hkdf::<Sha256>::new(Some(b"dstack-guest-v1"), app_key)
        .expand(&info, &mut key)
        .unwrap();
    key
}

#[test]
fn v1_key_matches_the_dstack_test_vectors() {
    let app_key =
        hex::decode("1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b").unwrap();
    assert_eq!(
        hex::encode(v1_key(&app_key, "secp256k1", "")),
        "59f60584ce6fd2a3a31997256db9d77322463fc8a6b1520110401bcb1ee92387"
    );
    assert_eq!(
        hex::encode(v1_key(&app_key, "secp256k1", "a/b/c")),
        "7f0973449298085d2d36a3b4c4d3243c100ba1981ffa885fe9e9dee883e69538"
    );
}

#[tokio::test]
#[ignore = "needs the dstack simulator"]
async fn the_root_is_the_v1_key_for_keelson_root() {
    let endpoint = endpoint();
    let keys: Value = serde_json::from_str(
        &std::fs::read_to_string(Path::new(&endpoint).with_file_name("appkeys.json")).unwrap(),
    )
    .unwrap();
    let app_key = hex::decode(keys["k256_key"].as_str().unwrap()).unwrap();
    let expected = Root::new(&v1_key(&app_key, "secp256k1", ROOT_DOMAIN));
    let root = Dstack::new(&endpoint).root().await.unwrap();
    assert_eq!(
        root.issuer_key().verifying_key(),
        expected.issuer_key().verifying_key()
    );
}

#[tokio::test]
#[ignore = "needs the dstack simulator"]
async fn boot_attests_the_signer_over_the_latest_block() {
    let dstack = Dstack::new(endpoint());
    let before = chain::latest_block(&chain::rpc_url()).await.unwrap().0;
    let (engine, attestation) = tdx::boot(config(None)).await.unwrap();

    assert_eq!(attestation.tee, "tdx");
    assert_eq!(attestation.binding, engine.binding().unwrap());
    assert_eq!(attestation.binding.signer, engine.signer());
    assert!(attestation.block.number >= before);

    let expected = report_data(&attestation.binding, attestation.block.hash.0).unwrap();
    let evidence = decode_attestation(&hex::decode(&attestation.attestation).unwrap()).unwrap();
    assert_eq!(evidence.report_data, expected);
    assert_eq!(hex::encode(&evidence.quote), attestation.quote);
    assert_eq!(evidence.quote[QUOTE_REPORT_DATA], expected);
    assert_eq!(evidence.event_log, attestation.event_log);

    let info = dstack.info().await.unwrap();
    assert_eq!(attestation.app_id, info.app_id);
    assert_eq!(attestation.compose_hash, info.compose_hash);
    assert_eq!(attestation.dstack_version, dstack.version().await.unwrap());

    let state = AppState::new(engine, [0; 32])
        .with_attestation(attestation.clone(), OffsetDateTime::now_utc());
    let refreshed = server::reattest(&state).await.unwrap();
    assert_eq!(refreshed.binding, attestation.binding);
    assert!(refreshed.block.number >= attestation.block.number);
}
