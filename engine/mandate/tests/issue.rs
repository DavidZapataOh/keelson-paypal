use keelson_mandate::{
    Error, Jwk, OPEN_MANDATE_TYP, OpenMandateParams, OpenMandateVerifyOptions, PasskeyCredential,
    USER_CREDENTIAL_TYP, UserAuth, UserCredentialParams, issue_open_mandate, issue_user_credential,
    verify_credential,
};
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

fn signing_key(derived: &Value) -> SigningKey {
    SigningKey::from_slice(&hex(&derived["secret"])).unwrap()
}

fn jwk(v: &Value) -> Jwk {
    Jwk::from_value(v).unwrap()
}

fn replay(salts: &Value) -> impl FnMut() -> [u8; 16] {
    let mut salts = salts.as_array().unwrap().clone().into_iter();
    move || {
        hex(&salts.next().expect("enough salts"))
            .try_into()
            .unwrap()
    }
}

fn str(v: &Value) -> String {
    v.as_str().unwrap().into()
}

fn user_credential_params(p: &Value) -> UserCredentialParams {
    UserCredentialParams {
        iss: str(&p["iss"]),
        sub: str(&p["sub"]),
        cred: PasskeyCredential {
            id: str(&p["cred"]["id"]),
            rp_id: str(&p["cred"]["rp_id"]),
            jwk: jwk(&p["cred"]["jwk"]),
        },
        holder_jwk: jwk(&p["holderJwk"]),
    }
}

fn open_mandate_params(p: &Value) -> OpenMandateParams {
    let auth = &p["userAuth"];
    OpenMandateParams {
        user_credential: str(&p["userCredential"]),
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
    }
}

fn verify_options(v: &Value) -> OpenMandateVerifyOptions {
    OpenMandateVerifyOptions {
        expected_aud: str(&v["expectedAud"]),
        expected_nonce: str(&v["expectedNonce"]),
        now: v["now"].as_i64().unwrap(),
        max_skew_sec: v["maxSkewSec"].as_i64().unwrap(),
    }
}

#[test]
fn issues_the_user_credential_byte_for_byte() {
    let v = vectors();
    let l1 = &v["userCredential"];
    let token = issue_user_credential(
        &user_credential_params(&l1["params"]),
        &signing_key(&v["issuer"]),
        &mut replay(&l1["salts"]),
        l1["params"]["iat"].as_i64().unwrap(),
    )
    .unwrap();
    assert_eq!(token, l1["expected"].as_str().unwrap());
    verify_credential(&token, USER_CREDENTIAL_TYP, &jwk(&v["issuer"]["jwk"]), None).unwrap();
}

#[test]
fn issues_the_open_mandate_byte_for_byte() {
    let v = vectors();
    let l2 = &v["openMandate"];
    let token = issue_open_mandate(
        &open_mandate_params(&l2["params"]),
        &signing_key(&v["users"][0]),
        &mut replay(&l2["salts"]),
        l2["params"]["iat"].as_i64().unwrap(),
    )
    .unwrap();
    assert_eq!(token, l2["expected"].as_str().unwrap());
    let verified = verify_credential(
        &token,
        OPEN_MANDATE_TYP,
        &jwk(&v["issuer"]["jwk"]),
        Some(&verify_options(&l2["verify"])),
    )
    .unwrap();
    assert_eq!(verified.claims["mid"], l2["params"]["nonce"]);
}

#[test]
fn rejects_a_repeated_salt() {
    let v = vectors();
    let l1 = &v["userCredential"];
    let result = issue_user_credential(
        &user_credential_params(&l1["params"]),
        &signing_key(&v["issuer"]),
        &mut || [7; 16],
        0,
    );
    assert!(matches!(result, Err(Error::Credential(_))));
}

#[test]
fn rejects_a_user_credential_that_is_not_a_bare_sd_jwt() {
    let v = vectors();
    let l2 = &v["openMandate"];
    let mut params = open_mandate_params(&l2["params"]);
    let key = signing_key(&v["users"][0]);
    for bad in [
        params.user_credential.trim_end_matches('~').to_owned(),
        format!("{}~", params.user_credential),
    ] {
        params.user_credential = bad;
        let result = issue_open_mandate(&params, &key, &mut replay(&l2["salts"]), 0);
        assert!(matches!(result, Err(Error::Credential(_))));
    }
}

#[test]
fn rejects_a_payload_without_an_agent_key_or_a_malformed_user_auth() {
    let v = vectors();
    let l2 = &v["openMandate"];
    let key = signing_key(&v["users"][0]);

    let mut params = open_mandate_params(&l2["params"]);
    params.payload_sd.as_object_mut().unwrap().remove("cnf");
    let result = issue_open_mandate(&params, &key, &mut replay(&l2["salts"]), 0);
    assert!(matches!(result, Err(Error::Credential(_))));

    let mut params = open_mandate_params(&l2["params"]);
    params.user_auth.signature = "not base64url!".into();
    let result = issue_open_mandate(&params, &key, &mut replay(&l2["salts"]), 0);
    assert!(matches!(result, Err(Error::Credential(_))));
}

#[test]
fn rejects_an_iat_beyond_the_safe_integer_range() {
    let v = vectors();
    let l1 = &v["userCredential"];
    let l2 = &v["openMandate"];
    let iat = 1 << 53;
    let result = issue_user_credential(
        &user_credential_params(&l1["params"]),
        &signing_key(&v["issuer"]),
        &mut replay(&l1["salts"]),
        iat,
    );
    assert!(matches!(result, Err(Error::Credential(_))));
    let result = issue_open_mandate(
        &open_mandate_params(&l2["params"]),
        &signing_key(&v["users"][0]),
        &mut replay(&l2["salts"]),
        iat,
    );
    assert!(matches!(result, Err(Error::Credential(_))));
}

/// The vector's params with the members of `overrides` replaced.
fn merged(base: &Value, overrides: &Value) -> Value {
    let mut params = base.clone();
    for (k, v) in overrides.as_object().unwrap() {
        params[k] = v.clone();
    }
    params
}

#[test]
fn refuses_what_the_verifiers_would_reject() {
    let v = vectors();
    let errors = v["errors"].as_array().unwrap();
    assert_eq!(errors.len(), 17);
    for c in errors {
        assert_eq!(c["expected"], "error", "{}", c["name"]);
        let key = signing_key(if c["signer"] == "issuer" {
            &v["issuer"]
        } else {
            &v["users"][0]
        });
        let mut salt = 0u8;
        let mut salts = || {
            salt += 1;
            [salt; 16]
        };
        let result = if c["credential"] == "user" {
            let p = merged(&v["userCredential"]["params"], &c["params"]);
            let iat = p["iat"].as_i64().unwrap();
            issue_user_credential(&user_credential_params(&p), &key, &mut salts, iat)
        } else {
            let p = merged(&v["openMandate"]["params"], &c["params"]);
            let iat = p["iat"].as_i64().unwrap();
            issue_open_mandate(&open_mandate_params(&p), &key, &mut salts, iat)
        };
        assert!(result.is_err(), "{} was issued", c["name"]);
    }
}
