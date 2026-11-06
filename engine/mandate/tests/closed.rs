use keelson_mandate::{
    ClosedMandateVerifyOptions, Error, Jwk, OpenMandateVerifyOptions, verify_closed_mandate,
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Vector {
    name: String,
    input: Value,
    expected: Value,
}

fn vectors() -> Vec<Vector> {
    serde_json::from_str(include_str!(
        "../../../packages/mandate/test/vectors/closed-mandate.json"
    ))
    .expect("vectors file is valid")
}

fn options(o: &Value) -> ClosedMandateVerifyOptions {
    let open = &o["open"];
    ClosedMandateVerifyOptions {
        open: OpenMandateVerifyOptions {
            expected_aud: open["expectedAud"].as_str().unwrap().into(),
            expected_nonce: open["expectedNonce"].as_str().unwrap().into(),
            now: open["now"].as_i64().unwrap(),
            max_skew_sec: open["maxSkewSec"].as_i64().unwrap(),
        },
        request_id: o["requestId"].as_str().unwrap().into(),
        cart_hash: o["cartHash"].as_str().unwrap().into(),
    }
}

/// The outcome as the vectors record it.
fn outcome(input: &Value) -> Value {
    let result = verify_closed_mandate(
        input["token"].as_str().unwrap(),
        &Jwk::from_value(&input["jwk"]).unwrap(),
        &options(&input["opts"]),
    );
    match result {
        Ok(v) => json!({
            "agentJwk": { "kty": "EC", "crv": "P-256", "x": v.agent_jwk.x, "y": v.agent_jwk.y },
            "iat": v.iat,
            "claims": v.open.claims,
        }),
        Err(Error::Credential(code)) if code.starts_with("closed_") => json!({ "error": code }),
        Err(_) => json!("error"),
    }
}

#[test]
fn closed_mandate_vectors() {
    let vectors = vectors();
    assert_eq!(vectors.len(), 16);
    for v in vectors {
        assert_eq!(outcome(&v.input), v.expected, "{}", v.name);
    }
}

#[test]
fn holder_signed_key_binding_is_rejected() {
    let v = vectors();
    let v = v.iter().find(|v| v.name == "error/holder-signed").unwrap();
    assert_eq!(outcome(&v.input), json!({ "error": "closed_signature" }));
}

/// Changing any byte of the agent's key binding makes it fail.
#[test]
fn key_binding_is_tamper_evident() {
    let v = vectors();
    let valid = v.iter().find(|v| v.name == "valid").unwrap();
    let token = valid.input["token"].as_str().unwrap();
    let start = token.rfind('~').unwrap() + 1;
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let accepted: Vec<usize> = (start..token.len())
        .filter(|&i| {
            let c = token.as_bytes()[i];
            let flipped = alphabet
                .iter()
                .position(|&a| a == c)
                .map_or(b'A', |j| alphabet[j ^ 1]);
            let mut tampered = token.as_bytes().to_vec();
            tampered[i] = flipped;
            let mut input = valid.input.clone();
            input["token"] = json!(String::from_utf8(tampered).unwrap());
            outcome(&input).get("agentJwk").is_some()
        })
        .collect();
    assert_eq!(accepted, Vec::<usize>::new());
}
