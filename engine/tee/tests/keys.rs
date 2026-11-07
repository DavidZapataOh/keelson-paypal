use keelson_mandate::{
    Jwk, OPEN_MANDATE_TYP, OpenMandateParams, OpenMandateVerifyOptions, PasskeyCredential,
    UserAuth, UserCredentialParams, issue_open_mandate, issue_user_credential, verify_credential,
};
use keelson_tee::{Root, SealAad, SealError};
use p256::ecdsa::SigningKey;
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/mandate/test/vectors/issued.json"
    ))
    .expect("vectors file is valid")
}

fn hex(v: &Value) -> Vec<u8> {
    let s = v.as_str().unwrap().strip_prefix("0x").unwrap();
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn root() -> Root {
    Root::new(&hex(&vectors()["root"]).try_into().unwrap())
}

fn secret(key: &SigningKey) -> Vec<u8> {
    key.to_bytes().to_vec()
}

fn jwk_of(key: &SigningKey) -> Jwk {
    Jwk::from_verifying_key(key.verifying_key())
}

fn str(v: &Value) -> String {
    v.as_str().unwrap().into()
}

fn replay(salts: &Value) -> impl FnMut() -> [u8; 16] {
    let mut salts = salts.as_array().unwrap().clone().into_iter();
    move || {
        hex(&salts.next().expect("enough salts"))
            .try_into()
            .unwrap()
    }
}

#[test]
fn derives_the_issuer_key_of_the_vectors() {
    let v = vectors();
    let issuer = root().issuer_key();
    assert_eq!(secret(&issuer), hex(&v["issuer"]["secret"]));
    assert_eq!(
        jwk_of(&issuer),
        Jwk::from_value(&v["issuer"]["jwk"]).unwrap()
    );
}

#[test]
fn derives_the_holder_keys_of_the_vectors() {
    let v = vectors();
    let root = root();
    for user in v["users"].as_array().unwrap() {
        let key = root.user_key(user["sub"].as_str().unwrap());
        assert_eq!(secret(&key), hex(&user["secret"]), "{}", user["sub"]);
    }
}

#[test]
fn derives_distinct_keys_per_user() {
    let root = root();
    assert_ne!(secret(&root.user_key("a")), secret(&root.user_key("b")));
    assert_ne!(secret(&root.user_key("")), secret(&root.issuer_key()));
}

#[test]
fn issues_credentials_the_verifiers_accept() {
    let v = vectors();
    let root = root();
    let (l1, l2) = (&v["userCredential"], &v["openMandate"]);
    let p = &l1["params"];
    let sub = str(&p["sub"]);
    let holder = root.user_key(&sub);
    let user_credential = issue_user_credential(
        &UserCredentialParams {
            iss: str(&p["iss"]),
            sub,
            cred: PasskeyCredential {
                id: str(&p["cred"]["id"]),
                rp_id: str(&p["cred"]["rp_id"]),
                jwk: Jwk::from_value(&p["cred"]["jwk"]).unwrap(),
            },
            holder_jwk: jwk_of(&holder),
        },
        &root.issuer_key(),
        &mut replay(&l1["salts"]),
        p["iat"].as_i64().unwrap(),
    )
    .unwrap();
    assert_eq!(user_credential, l1["expected"].as_str().unwrap());

    let p = &l2["params"];
    let auth = &p["userAuth"];
    let open_mandate = issue_open_mandate(
        &OpenMandateParams {
            user_credential,
            payload_sd: p["payloadSd"].clone(),
            disclosures: p["disclosures"]
                .as_array()
                .unwrap()
                .iter()
                .map(str)
                .collect(),
            user_auth: UserAuth {
                authenticator_data: str(&auth["authenticatorData"]),
                client_data_json: str(&auth["clientDataJSON"]),
                signature: str(&auth["signature"]),
            },
            aud: str(&p["aud"]),
            nonce: str(&p["nonce"]),
        },
        &holder,
        &mut replay(&l2["salts"]),
        p["iat"].as_i64().unwrap(),
    )
    .unwrap();
    assert_eq!(open_mandate, l2["expected"].as_str().unwrap());
    let o = &l2["verify"];
    verify_credential(
        &open_mandate,
        OPEN_MANDATE_TYP,
        &jwk_of(&root.issuer_key()),
        Some(&OpenMandateVerifyOptions {
            expected_aud: str(&o["expectedAud"]),
            expected_nonce: str(&o["expectedNonce"]),
            now: o["now"].as_i64().unwrap(),
            max_skew_sec: o["maxSkewSec"].as_i64().unwrap(),
        }),
    )
    .unwrap();
}

const AAD: SealAad = SealAad {
    purpose: "keelson/seal/test/v1",
    sub: Some("kls_usr_7f3a9c21"),
    record: b"record",
};

#[test]
fn unseals_what_it_sealed() {
    let root = root();
    for plaintext in [&b""[..], b"x", &[0xa5; 4096]] {
        let blob = root.seal(&AAD, plaintext);
        assert_eq!(blob[0], 1);
        assert_eq!(blob.len(), 1 + 12 + plaintext.len() + 16);
        assert_eq!(root.unseal(&AAD, &blob).unwrap(), plaintext);
    }
}

#[test]
fn draws_a_fresh_nonce_per_seal() {
    let root = root();
    assert_ne!(root.seal(&AAD, b"same"), root.seal(&AAD, b"same"));
}

#[test]
fn rejects_tampered_blobs() {
    let root = root();
    let blob = root.seal(&AAD, b"secret");
    for i in 0..blob.len() {
        let mut tampered = blob.clone();
        tampered[i] ^= 1;
        assert_eq!(root.unseal(&AAD, &tampered), Err(SealError), "byte {i}");
    }
    assert_eq!(root.unseal(&AAD, &blob[..blob.len() - 1]), Err(SealError));
    for short in 0..29 {
        assert_eq!(
            root.unseal(&AAD, &blob[..short.min(blob.len())]),
            Err(SealError)
        );
    }
}

#[test]
fn a_blob_opens_only_for_its_purpose_user_and_record() {
    let root = root();
    let blob = root.seal(&AAD, b"secret");
    let others = [
        SealAad {
            purpose: "keelson/seal/other/v1",
            ..AAD
        },
        SealAad {
            sub: Some("kls_usr_other"),
            ..AAD
        },
        SealAad { sub: None, ..AAD },
        SealAad {
            sub: Some(""),
            ..AAD
        },
        SealAad {
            record: b"other",
            ..AAD
        },
        SealAad { record: b"", ..AAD },
        // The same bytes split differently between the parts.
        SealAad {
            purpose: "keelson/seal/test/v1kls",
            sub: Some("_usr_7f3a9c21"),
            record: b"record",
        },
        SealAad {
            purpose: "keelson/seal/test/v1",
            sub: Some("kls_usr_7f3a9c21rec"),
            record: b"ord",
        },
    ];
    for other in &others {
        assert_eq!(root.unseal(other, &blob), Err(SealError), "{other:?}");
    }
}

#[test]
fn rejects_blobs_sealed_under_another_root() {
    let blob = root().seal(&AAD, b"secret");
    assert_eq!(Root::new(&[7; 32]).unseal(&AAD, &blob), Err(SealError));
}
