use keelson_core::AcirField;
use keelson_mandate::{
    Error, Fr, Jwk, LeafPreimage, MembershipProof, NonMembershipProof, OpenMandateVerifyOptions,
    VerifiedCredential, category_mask, decode_disclosed, decode_mandate, h_sd, is_merchant_id,
    mandate_challenge, mandate_commitment, merchant_leaf, merchant_membership,
    merchant_non_membership, merchant_root, merchant_tree, parse_mandate, user_key_hash,
    verify_credential, verify_merchant_membership, verify_merchant_non_membership,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
struct Vector {
    name: String,
    input: Value,
    expected: Value,
}

fn load(json: &str) -> Vec<Vector> {
    serde_json::from_str(json).expect("vectors file is valid")
}

fn is_error(v: &Value) -> bool {
    v == "error"
}

fn field(v: &Value) -> Fr {
    Fr::from_hex(v.as_str().unwrap()).unwrap()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn field_hex(f: &Fr) -> Value {
    json!(format!("0x{}", f.to_hex()))
}

fn bytes<const N: usize>(v: &Value) -> [u8; N] {
    let s = v.as_str().unwrap().strip_prefix("0x").unwrap();
    let bytes: Vec<u8> = (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect();
    bytes.try_into().unwrap()
}

fn strings(v: &Value) -> Vec<String> {
    serde_json::from_value(v.clone()).unwrap()
}

/// Checks `result` against a vector's `expected`: the output, `"error"`, or
/// `{ "error": "mandate", "field": … }` for a mandate rejected on that field.
fn assert_outcome<T>(
    name: &str,
    result: Result<T, Error>,
    expected: &Value,
    to_json: impl Fn(T) -> Value,
) {
    match (result, expected.get("field")) {
        (Ok(v), _) => assert_eq!(&to_json(v), expected, "{name}"),
        (Err(Error::Mandate { field, .. }), Some(f)) => assert_eq!(field, *f, "{name}"),
        (Err(e), Some(_)) => panic!("{name}: expected a mandate error, got {e}"),
        (Err(e), None) => assert!(is_error(expected), "{name}: unexpected error {e}"),
    }
}

#[test]
fn sd_vectors() {
    let vectors = load(include_str!(
        "../../../packages/mandate/test/vectors/sd.json"
    ));
    assert_eq!(vectors.len(), 106);
    for v in vectors {
        let disclosures = strings(&v.input["disclosures"]);
        let result = match v.input["op"].as_str() {
            None => decode_disclosed(&v.input["payloadSd"], &disclosures),
            Some("decodeMandate") => decode_mandate(&v.input["payloadSd"], &disclosures),
            Some(op) => panic!("unknown op {op}"),
        };
        assert_outcome(&v.name, result, &v.expected, |m| m);
    }
}

#[test]
fn challenge_vectors() {
    let vectors = load(include_str!(
        "../../../packages/mandate/test/vectors/challenge.json"
    ));
    assert_eq!(vectors.len(), 6);
    for v in vectors {
        let digest = match v.input["op"].as_str().unwrap() {
            "hSd" => h_sd(&v.input["payloadSd"]).unwrap(),
            "mandateChallenge" => {
                mandate_challenge(&bytes(&v.input["hSd"]), &field(&v.input["cm"]))
            }
            op => panic!("unknown op {op}"),
        };
        assert_eq!(
            json!(format!("0x{}", hex(&digest))),
            v.expected,
            "{}",
            v.name
        );
    }
}

fn demo() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/mandate/test/fixtures/demo-mandate.json"
    ))
    .unwrap()
}

fn leaf_json(l: &LeafPreimage) -> Value {
    json!({ "value": field_hex(&l.value), "next": field_hex(&l.next), "nextIndex": l.next_index })
}

fn leaf_from(v: &Value) -> LeafPreimage {
    LeafPreimage {
        value: field(&v["value"]),
        next: field(&v["next"]),
        next_index: v["nextIndex"].as_u64().unwrap() as usize,
    }
}

fn path_json(path: &[Fr]) -> Value {
    Value::Array(path.iter().map(field_hex).collect())
}

fn path_from(v: &Value) -> Vec<Fr> {
    v.as_array().unwrap().iter().map(field).collect()
}

#[test]
fn commitment_vectors() {
    let vectors = load(include_str!(
        "../../../packages/mandate/test/vectors/commitment.json"
    ));
    assert_eq!(vectors.len(), 311);
    for v in vectors {
        let (i, name, expected) = (&v.input, v.name.as_str(), &v.expected);
        match i["op"].as_str().unwrap() {
            "merchantLeaf" => {
                let id = match i.get("utf16") {
                    Some(units) => String::from_utf16(
                        &serde_json::from_value::<Vec<u16>>(units.clone()).unwrap(),
                    ),
                    None => Ok(i["id"].as_str().unwrap().to_owned()),
                };
                match id {
                    Ok(id) => assert_outcome(name, merchant_leaf(&id), expected, |f| field_hex(&f)),
                    Err(_) => assert!(is_error(expected), "{name}: not UTF-16 but accepted by TS"),
                }
            }
            "merchantRoot" => {
                assert_outcome(name, merchant_root(&strings(&i["ids"])), expected, |f| {
                    field_hex(&f)
                });
            }
            "membership" => {
                let tree = merchant_tree(&strings(&i["ids"])).unwrap();
                let id = i["id"].as_str().unwrap();
                let proof = merchant_membership(&tree, id);
                if let Ok(p) = &proof {
                    assert!(
                        verify_merchant_membership(&tree.root(), id, p).unwrap(),
                        "{name}"
                    );
                    let forged = MembershipProof {
                        index: p.index ^ 1,
                        ..p.clone()
                    };
                    assert!(
                        !verify_merchant_membership(&tree.root(), id, &forged).unwrap(),
                        "{name}"
                    );
                }
                assert_outcome(
                    name,
                    proof,
                    expected,
                    |p| json!({ "leaf": leaf_json(&p.leaf), "path": path_json(&p.path), "index": p.index }),
                );
            }
            "nonMembership" => {
                let tree = merchant_tree(&strings(&i["ids"])).unwrap();
                let id = i["id"].as_str().unwrap();
                let proof = merchant_non_membership(&tree, id);
                if let Ok(p) = &proof {
                    assert!(
                        verify_merchant_non_membership(&tree.root(), id, p).unwrap(),
                        "{name}"
                    );
                }
                assert_outcome(
                    name,
                    proof,
                    expected,
                    |p| json!({ "leaf": leaf_json(&p.low), "path": path_json(&p.path), "index": p.index }),
                );
            }
            "verifyNonMembership" => {
                let p = &i["proof"];
                let proof = NonMembershipProof {
                    low: leaf_from(&p["leaf"]),
                    path: path_from(&p["path"]),
                    index: p["index"].as_u64().unwrap() as usize,
                };
                let ok = verify_merchant_non_membership(
                    &field(&i["root"]),
                    i["id"].as_str().unwrap(),
                    &proof,
                );
                assert_eq!(json!(ok.unwrap()), *expected, "{name}");
            }
            "verifyMembership" => {
                let p = &i["proof"];
                let proof = MembershipProof {
                    leaf: leaf_from(&p["leaf"]),
                    path: path_from(&p["path"]),
                    index: p["index"].as_u64().unwrap() as usize,
                };
                let ok = verify_merchant_membership(
                    &field(&i["root"]),
                    i["id"].as_str().unwrap(),
                    &proof,
                );
                assert_eq!(json!(ok.unwrap()), *expected, "{name}");
            }
            "categoryMask" => {
                let result = category_mask(&strings(&i["categories"]));
                assert_outcome(name, result, expected, |m| json!(m.to_string()));
            }
            "isMerchantId" => {
                assert_eq!(
                    json!(is_merchant_id(i["id"].as_str().unwrap())),
                    *expected,
                    "{name}"
                );
            }
            "parseWebsite" => {
                let mut m = demo();
                for c in m["checkout"]["constraints"].as_array_mut().unwrap() {
                    if c["type"] == "checkout.allowed_merchants" {
                        for x in c["allowed"].as_array_mut().unwrap() {
                            x["website"] = i["website"].clone();
                        }
                    }
                }
                assert_outcome(name, parse_mandate(&m), expected, |()| json!(true));
            }
            "userKeyHash" => {
                let jwk = &i["jwk"];
                let result = user_key_hash(jwk["x"].as_str().unwrap(), jwk["y"].as_str().unwrap());
                assert_outcome(name, result, expected, |f| field_hex(&f));
            }
            "mandateCommitment" => {
                let result = mandate_commitment(&i["mandate"], bytes(&i["salt"]));
                assert_outcome(name, result, expected, |f| field_hex(&f));
            }
            "parseMandate" => {
                assert_outcome(name, parse_mandate(&i["mandate"]), expected, |()| {
                    json!(true)
                });
            }
            op => panic!("unknown op {op}"),
        }
    }
}

fn options(v: &Value) -> Option<OpenMandateVerifyOptions> {
    v.as_object().map(|o| OpenMandateVerifyOptions {
        expected_aud: o["expectedAud"].as_str().unwrap().into(),
        expected_nonce: o["expectedNonce"].as_str().unwrap().into(),
        now: o["now"].as_i64().unwrap(),
        max_skew_sec: o["maxSkewSec"].as_i64().unwrap(),
    })
}

fn credential_json(v: &VerifiedCredential) -> Value {
    let mut out = json!({ "header": v.header, "payload": v.payload, "claims": v.claims });
    if let Some(user_auth) = &v.user_auth {
        out["userAuth"] = user_auth.clone();
    }
    if let Some(uc) = &v.user_credential {
        out["userCredential"] = credential_json(uc);
    }
    out
}

fn verify(i: &Value) -> Result<VerifiedCredential, keelson_mandate::Error> {
    verify_credential(
        i["token"].as_str().unwrap(),
        i["typ"].as_str().unwrap(),
        &Jwk::from_value(&i["jwk"]).unwrap(),
        options(&i["opts"]).as_ref(),
    )
}

#[test]
fn credential_vectors() {
    let vectors = load(include_str!(
        "../../../packages/mandate/test/vectors/credentials.json"
    ));
    assert_eq!(vectors.len(), 109);
    for v in vectors {
        assert_outcome(&v.name, verify(&v.input), &v.expected, |c| {
            credential_json(&c)
        });
    }
}

/// Changing any byte of a valid open mandate makes it fail.
#[test]
fn open_mandate_is_tamper_evident() {
    let vectors = load(include_str!(
        "../../../packages/mandate/test/vectors/credentials.json"
    ));
    let valid = vectors.iter().find(|v| v.name == "l2/valid").unwrap();
    assert!(verify(&valid.input).is_ok());
    let token = valid.input["token"].as_str().unwrap();
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let accepted: Vec<usize> = (0..token.len())
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
            verify(&input).is_ok()
        })
        .collect();
    assert_eq!(accepted, Vec::<usize>::new());
}

/// A chain of thousands of disclosures, each nested in the previous one, is rejected without
/// exhausting the stack.
#[test]
fn deep_disclosure_chain_is_rejected() {
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use sha2::{Digest, Sha256};

    let mut value = json!({});
    let mut disclosures = Vec::new();
    for i in 0..5000 {
        let encoded = URL_SAFE_NO_PAD.encode(json!([format!("salt{i}"), "c", value]).to_string());
        value = json!({ "_sd": [URL_SAFE_NO_PAD.encode(Sha256::digest(&encoded))] });
        disclosures.push(encoded);
    }
    assert!(decode_disclosed(&value, &disclosures).is_err());
}

#[test]
fn jwk_thumbprint_is_rfc_7638() {
    let jwk = Jwk {
        x: "uczbfm_5YyCrEoef1kpWdV_V-xQ9HArkKCXRghPX6uQ".into(),
        y: "ambpuuW6F-X2H1Zn4EcxTnkOs3lBk0-VNojK7Fm__5k".into(),
        kid: Some("ignored".into()),
    };
    let expected = "65d9df25e449486770f779293a8cffa583540a09c088d2e2ee818a0dd1721420";
    let hex: String = jwk
        .thumbprint()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(hex, expected);
}

#[test]
fn fx_spread_cap() {
    let mut m = demo();
    m["fx"] = json!({ "max_spread_bps": 600 });
    assert!(parse_mandate(&m).is_ok());
    for bad in [json!(-1), json!(3_001), json!(1.5), json!("600")] {
        m["fx"] = json!({ "max_spread_bps": bad });
        let err = parse_mandate(&m).unwrap_err().to_string();
        assert!(err.contains("fx.max_spread_bps"), "{err}");
    }
    m["fx"] = json!({ "max_spread_bps": 600, "extra": 1 });
    assert!(parse_mandate(&m).is_err());
}

/// The literal of `pub global <name>: Field` in a Noir file the TypeScript generators write.
fn noir_literal<'a>(src: &'a str, name: &str) -> &'a str {
    let prefix = format!("pub global {name}: Field = ");
    src.lines()
        .find_map(|l| l.strip_prefix(&prefix))
        .unwrap_or_else(|| panic!("no global {name}"))
        .trim_end_matches(';')
}

fn noir_global(src: &str, name: &str) -> Value {
    field_hex(&Fr::from_hex(noir_literal(src, name)).unwrap())
}

/// The salt as the circuits take it: a field whose low 16 bytes are the commitment's salt.
fn noir_salt(src: &str) -> [u8; 16] {
    let salt: [u8; 32] = bytes(&json!(noir_literal(src, "SALT")));
    salt[16..].try_into().unwrap()
}

#[test]
fn circuit_vectors_are_what_the_engine_computes() {
    let c1 = include_str!("../../../circuits/c1/src/vectors.nr");
    let c2a = include_str!("../../../circuits/c2a/src/vectors.nr");
    let c3 = include_str!("../../../circuits/c3/src/vectors.nr");
    let c3_json: Value = serde_json::from_str(include_str!(
        "../../../packages/mandate/test/vectors/c3.json"
    ))
    .unwrap();

    let demo_cm = mandate_commitment(&demo(), noir_salt(c1)).unwrap();
    assert_eq!(field_hex(&demo_cm), noir_global(c1, "C_M"));
    assert_eq!(field_hex(&demo_cm), noir_global(c2a, "C_M"));

    let mut euro = demo();
    euro["payment"]["currency"] = json!("EUR");
    for c in euro["payment"]["constraints"].as_array_mut().unwrap() {
        if c.get("currency").is_some() {
            c["currency"] = json!("EUR");
        }
    }
    let euro_cm = mandate_commitment(&euro, noir_salt(c2a)).unwrap();
    assert_eq!(field_hex(&euro_cm), noir_global(c2a, "C_M_EUR"));

    let cm = mandate_commitment(&c3_json["mandate"], noir_salt(c3)).unwrap();
    assert_eq!(field_hex(&cm), noir_global(c3, "C_M"));
    let challenge = mandate_challenge(&h_sd(&c3_json["payloadSd"]).unwrap(), &cm);
    assert_eq!(
        field_hex(&Fr::from_be_bytes_reduce(challenge.as_slice())),
        noir_global(c3, "MANDATE_HASH")
    );
    let rp_id_hash = Sha256::digest(b"keelson.finance");
    assert_eq!(
        field_hex(&Fr::from_be_bytes_reduce(rp_id_hash.as_slice())),
        noir_global(c3, "RP_ID_HASH")
    );
}
