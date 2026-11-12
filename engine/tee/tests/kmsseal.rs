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

// KMS answers a `Recipient` decrypt with BER, not DER: indefinite lengths, a subjectKeyIdentifier
// recipient and the encrypted content as a constructed string of OCTET STRING segments, as
// aws-nitro-enclaves-sdk-c's `aws_cms_parse_enveloped_data` reads it. `openssl cms -encrypt
// -binary -recip <cert> -keyid -keyopt rsa_padding_mode:oaep -keyopt rsa_oaep_md:sha256 -keyopt
// rsa_mgf1_md:sha256 -aes-256-cbc -stream -outform DER` encodes it the same way, here for a
// fresh RSA-2048 key as `recipient_key` makes.

#[test]
fn cms_opens_kms_ber_envelope() {
    let key = PrivateKey::from_pkcs8_der(&read("kms-recipient-key.der")).unwrap();
    let plain = open_envelope(&read("kms-enveloped.ber"), &key).unwrap();
    assert_eq!(plain.as_slice(), b"sandbox-secret");
}

#[test]
fn cms_joins_segmented_content() {
    let key = PrivateKey::from_pkcs8_der(&read("kms-recipient-key.der")).unwrap();
    let plain = open_envelope(&read("kms-segmented.ber"), &key).unwrap();
    assert_eq!(plain.as_slice(), "keelson ".repeat(625).as_bytes());
}

#[test]
fn malformed_ber_is_refused() {
    let key = PrivateKey::from_pkcs8_der(&read("kms-recipient-key.der")).unwrap();
    let ber = read("kms-enveloped.ber");
    for cut in [1, 2, ber.len() / 2, ber.len() - 2, ber.len() - 1] {
        assert!(open_envelope(&ber[..cut], &key).is_err(), "cut at {cut}");
    }
    let mut trailing = ber.clone();
    trailing.push(0);
    assert!(open_envelope(&trailing, &key).is_err());
    assert!(open_envelope(&[0x30, 0x80].repeat(64), &key).is_err());
}

#[test]
fn another_key_cannot_open_it() {
    let (other, spki) = recipient_key().unwrap();
    assert!(spki.len() > 256);
    assert!(open_envelope(&read("enveloped.der"), &other).is_err());
    let wrong_key = open_envelope(&read("kms-enveloped.ber"), &other).unwrap_err();
    assert_eq!(wrong_key.class(), "the content key is not for this enclave");
    assert_eq!(
        open_envelope(b"not der", &other).unwrap_err().class(),
        "not BER"
    );
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
