//! Leg A's engine booted once under the TDX leg's app on Phala's on-chain KMS (Base), by
//! `scripts/rehearse.ts`: the log keys it derived chain to the constants the engine trusts.

use keelson_tee::kms::{APP_ID, KMS_ROOT, verify_chain};
use serde_json::Value;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn log_keys_of_the_rehearsal_chain_to_the_onchain_kms_app() {
    let keys: Value =
        serde_json::from_str(include_str!("fixtures/onchain-kms/getkey-chain.json")).unwrap();
    let keys = keys.as_array().unwrap();
    assert_eq!(keys.len(), 2);
    for key in keys {
        let chain: Vec<Vec<u8>> = key["chain"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| hex(l.as_str().unwrap()))
            .collect();
        assert_eq!(hex(key["app_id"].as_str().unwrap()), APP_ID);
        assert_eq!(hex(key["kms_root"].as_str().unwrap()), KMS_ROOT);
        assert!(verify_chain(
            key["algorithm"].as_str().unwrap(),
            key["domain"].as_str().unwrap(),
            &hex(key["public_key"].as_str().unwrap()),
            &chain,
            &APP_ID,
            &KMS_ROOT,
        ));
    }
}

#[test]
fn the_rehearsal_booted_with_secure_time_under_the_app() {
    let timing: Value =
        serde_json::from_str(include_str!("fixtures/onchain-kms/boot-timing.json")).unwrap();
    assert!(
        timing
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["secure_time"] == true && t["boot_to_ready_ms"].as_u64().is_some())
    );
    let attest: Value =
        serde_json::from_str(include_str!("fixtures/onchain-kms/attest.json")).unwrap();
    assert_eq!(hex(attest["app_id"].as_str().unwrap()), APP_ID);
}
