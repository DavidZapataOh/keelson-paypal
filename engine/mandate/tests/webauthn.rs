use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use keelson_core::AcirField;
use keelson_mandate::{
    Assertion, Expected, Fr, WebAuthnError, decode_mandate, h_sd, mandate_challenge, parse_mandate,
    spc_details, verify_assertion,
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
        "../../../packages/mandate/test/vectors/webauthn.json"
    ))
    .expect("vectors file is valid")
}

fn text(v: &Value) -> String {
    v.as_str().unwrap().to_owned()
}

fn hex(v: &Value) -> Vec<u8> {
    let s = v.as_str().unwrap().strip_prefix("0x").unwrap();
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// The verdict as the vectors name it.
fn kind(e: WebAuthnError) -> &'static str {
    match e {
        WebAuthnError::ClientData => "client-data",
        WebAuthnError::Type => "type",
        WebAuthnError::Challenge => "challenge",
        WebAuthnError::Origin => "origin",
        WebAuthnError::CrossOrigin => "cross-origin",
        WebAuthnError::Payment(_) => "payment",
        WebAuthnError::AuthenticatorData => "authenticator-data",
        WebAuthnError::RpId => "rp-id",
        WebAuthnError::UserPresent => "user-present",
        WebAuthnError::UserVerified => "user-verified",
        WebAuthnError::BackupState => "backup-state",
        WebAuthnError::PublicKey => "public-key",
        WebAuthnError::Signature => "signature",
    }
}

fn verify(i: &Value) -> Result<(), WebAuthnError> {
    let disclosures: Vec<String> = serde_json::from_value(i["disclosures"].clone()).unwrap();
    let m = decode_mandate(&i["payloadSd"], &disclosures).unwrap();
    let cm = Fr::from_hex(i["cm"].as_str().unwrap()).unwrap();
    let a = &i["assertion"];
    verify_assertion(
        &Assertion {
            authenticator_data: text(&a["authenticatorData"]),
            client_data_json: text(&a["clientDataJSON"]),
            signature: text(&a["signature"]),
        },
        &Expected {
            challenge: mandate_challenge(&h_sd(&i["payloadSd"]).unwrap(), &cm),
            origin: text(&i["origin"]),
            rp_id: text(&i["rpId"]),
            public_key_sec1: hex(&i["publicKeySec1"]),
            spc: spc_details(&m).unwrap(),
        },
    )
}

#[test]
fn webauthn_vectors() {
    let vectors = vectors();
    assert_eq!(vectors.len(), 24);
    for v in vectors {
        match v.input["op"].as_str() {
            Some("verify") => {
                let verdict = verify(&v.input).err().map_or("ok", kind);
                assert_eq!(verdict, v.expected, "{}", v.name);
            }
            Some("spcDetails") => {
                let details = parse_mandate(&v.input["mandate"])
                    .and_then(|()| spc_details(&v.input["mandate"]));
                let got = details.map_or(json!("error"), |d| {
                    json!({
                        "payeeName": d.payee_name,
                        "payeeOrigin": d.payee_origin,
                        "total": { "currency": d.currency, "value": d.value },
                    })
                });
                assert_eq!(got, v.expected, "{}", v.name);
            }
            op => panic!("unknown op {op:?}"),
        }
    }
}

#[test]
fn payment_errors_name_the_field() {
    let v = vectors();
    let shown = v
        .iter()
        .find(|v| v.name == "verify/error/spc-total-shown")
        .unwrap();
    assert_eq!(
        verify(&shown.input),
        Err(WebAuthnError::Payment("total.value"))
    );
    assert_eq!(
        WebAuthnError::Payment("total.value").to_string(),
        "payment.total.value differs from the mandate"
    );
}

#[test]
fn hostile_input_is_rejected_without_panicking() {
    let v = vectors();
    let ok = &v
        .iter()
        .find(|v| v.name == "verify/ok/webauthn.get")
        .unwrap()
        .input;
    let base = || ok.clone();
    let with = |field: &str, value: &str| {
        let mut i = base();
        i["assertion"][field] = json!(value);
        verify(&i)
    };
    assert_eq!(with("clientDataJSON", "!!"), Err(WebAuthnError::ClientData));
    assert_eq!(with("clientDataJSON", "W10"), Err(WebAuthnError::Type));
    assert_eq!(
        with("authenticatorData", ""),
        Err(WebAuthnError::AuthenticatorData)
    );
    assert_eq!(with("signature", ""), Err(WebAuthnError::Signature));
    assert_eq!(with("signature", "MAA"), Err(WebAuthnError::Signature));

    let auth = URL_SAFE_NO_PAD
        .decode(ok["assertion"]["authenticatorData"].as_str().unwrap())
        .unwrap();
    for tail in [
        &[0xff][..],
        &[0x9f, 0x00],
        &[0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
        &[0x81; 64],
        &[0xa1, 0x61, 0x78, 0xf5],
    ] {
        let mut d = auth.clone();
        d[32] |= 0x80;
        d.extend_from_slice(tail);
        let mut i = base();
        i["assertion"]["authenticatorData"] = json!(URL_SAFE_NO_PAD.encode(&d));
        let r = verify(&i);
        let well_formed = tail == [0xa1, 0x61, 0x78, 0xf5];
        let expected = if well_formed {
            WebAuthnError::Signature
        } else {
            WebAuthnError::AuthenticatorData
        };
        assert_eq!(r, Err(expected), "{tail:02x?}");
    }

    let mut i = base();
    i["publicKeySec1"] = json!("0x04");
    assert_eq!(verify(&i), Err(WebAuthnError::PublicKey));
}
