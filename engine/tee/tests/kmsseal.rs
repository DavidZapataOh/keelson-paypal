//! Leg B's sealed PayPal credential: KMS's envelope opens with the enclave's key alone, and its
//! requests are signed as AWS's own SDK signs them.

use keelson_tee::kmsseal::{AwsSession, open_envelope, recipient_key, signed_headers};
use rsa::PrivateKey;
use rsa::pkcs8::DecodePrivateKey;
use serde_json::Value;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/cms");

fn read(name: &str) -> Vec<u8> {
    std::fs::read(format!("{FIXTURES}/{name}")).unwrap()
}

#[test]
fn cms_opens_openssl_envelope() {
    // `openssl cms -encrypt -recip recipient.pem -keyopt rsa_padding_mode:oaep -keyopt
    // rsa_oaep_md:sha256 -aes256 -binary -outform DER`, of `sandbox-secret`.
    let key = PrivateKey::from_pkcs8_der(&read("recipient-key.der")).unwrap();
    let plain = open_envelope(&read("enveloped.der"), &key).unwrap();
    assert_eq!(plain.as_slice(), b"sandbox-secret");
}

#[test]
fn another_key_cannot_open_it() {
    let (other, spki) = recipient_key().unwrap();
    assert!(spki.len() > 256);
    assert!(open_envelope(&read("enveloped.der"), &other).is_err());
    assert!(open_envelope(b"not der", &other).is_err());
}

#[test]
fn signs_a_kms_decrypt_as_the_aws_sdk_does() {
    let v: Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/vectors/sigv4/kms-decrypt.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let s = |k: &str| v[k].as_str().unwrap().to_owned();
    let session = AwsSession {
        region: s("region"),
        access_key_id: s("access_key_id"),
        secret_access_key: s("secret_access_key"),
        session_token: s("session_token"),
    };
    let headers = signed_headers(
        &session,
        "TrentService.Decrypt",
        s("body").as_bytes(),
        &s("amz_date"),
    );
    let auth = headers.iter().find(|(k, _)| *k == "authorization").unwrap();
    assert_eq!(auth.1, v["headers"]["Authorization"].as_str().unwrap());
}
