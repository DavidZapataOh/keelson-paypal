//! Leg A signs a standard export with its attested issuer key, only over facts a logged statement
//! backs.

mod common;

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use common::*;
use keelson_core::statement::{build_receipt, leaf_hash, receipt_protected, with_receipts};
use keelson_tee::logsign::{LogKey, LogSigner, SignRequest};
use keelson_tee::wire::{ExportRequest, Hex, LegMeasurements, StatementRequest};
use keelson_tee::{Engine, EngineError, ascii_json};
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::{Value, json};
use zeroize::Zeroizing;

const ORIGIN: &str = "log.keelson.finance/alibi/2026-1";

fn leg() -> Engine {
    let key = LogKey::new(ORIGIN, &Zeroizing::new([9; 32]), vec![]);
    leg_a().with_log_signer(Arc::new(LogSigner::new(
        vec![key],
        Arc::new(Records::default()),
    )))
}

/// A countersign's statement, logged at index 0 of a two-leaf tree whose root this leg signed.
fn logged(engine: &Engine) -> (Vec<u8>, keelson_tee::wire::Countersigned) {
    let issued = register();
    let mut req = countersign_request(&issued, &CartFixture::demo(), request_id(50), None);
    req.statement = Some(StatementRequest {
        measurements: LegMeasurements {
            tdx: Hex([0x11; 32]),
            nitro: None,
        },
        ref_salt: None,
        leg_a: None,
    });
    let x = engine.countersign(&req, at(NOW + 10)).unwrap();
    let statement = x.statement.clone().unwrap().0;
    let (h0, h1) = (leaf_hash(&statement), leaf_hash(b"neighbour"));
    let mut node = sha2::Sha256::new();
    use sha2::Digest;
    node.update([1]);
    node.update(h0);
    node.update(h1);
    let tree: [u8; 32] = node.finalize().into();
    let body = format!(
        "{ORIGIN}\n2\n{}\n",
        base64::engine::general_purpose::STANDARD.encode(tree)
    );
    let signed = engine
        .log_signer()
        .unwrap()
        .sign(
            &root(),
            Some((0, [0; 32])),
            &SignRequest {
                checkpoint: body,
                from_size: None,
                consistency: vec![],
            },
        )
        .unwrap();
    let receipt_key = engine.log_signer().unwrap().keys()[0].receipt_public_key();
    let sig: [u8; 64] = base64::engine::general_purpose::STANDARD
        .decode(&signed.receipt_signature)
        .unwrap()
        .try_into()
        .unwrap();
    let receipt = build_receipt(&receipt_protected(&receipt_key, ORIGIN), sig, 2, 0, &[h1]);
    (with_receipts(&statement, &[receipt]).unwrap(), x)
}

fn facts(x: &keelson_tee::wire::Countersigned) -> Value {
    let c = &x.countersign;
    json!({
        "agent_id": c.agent_id,
        "amount_minor": c.amount,
        "cart_hash": format!("0x{}", hex(&c.cart_hash.0)),
        "currency": c.currency,
        "decision": if c.decision == "1" { "allow" } else { "deny" },
        "issued_at": c.issued_at.parse::<u64>().unwrap(),
        "mandate_hash": format!("0x{}", hex(&c.mandate_hash.0)),
        "merchant_id": format!("0x{}", hex(&c.merchant_id.0)),
        "request_id": request_id(50).to_string(),
    })
}

fn request(statement: &[u8], facts: Value) -> ExportRequest {
    let b64 = URL_SAFE_NO_PAD.encode(statement);
    ExportRequest {
        typ: "JWT".into(),
        payload: json!({
            "keelson": { "facts": facts, "profile": "keelson.export/1", "statement": b64 },
            "merchant": "Café Ñandú 東京 𝄞",
        }),
        statement: keelson_tee::wire::Base64(statement.to_vec()),
    }
}

#[test]
fn escapes_like_python_json_dumps() {
    let v: Value = serde_json::from_str(include_str!("vectors/exports/non-ascii.json")).unwrap();
    assert_eq!(
        ascii_json(&v["input"]),
        v["python_json_dumps_ensure_ascii"].as_str().unwrap()
    );
}

#[test]
fn signs_an_export_backed_by_its_own_receipt() {
    let engine = leg();
    let (statement, x) = logged(&engine);
    let r = request(&statement, facts(&x));
    let jws = engine.sign_export(&r).unwrap().jws;
    let parts: Vec<&str> = jws.split('.').collect();
    assert_eq!(parts.len(), 3);
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
    assert_eq!(header["alg"], "ES256");
    assert_eq!(header["typ"], "JWT");
    assert_eq!(
        URL_SAFE_NO_PAD.decode(parts[1]).unwrap(),
        ascii_json(&r.payload).into_bytes()
    );
    let issuer = root().issuer_key();
    let sig = Signature::from_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap()).unwrap();
    VerifyingKey::from(&issuer)
        .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig)
        .unwrap();
}

#[test]
fn refuses_what_the_statement_does_not_back() {
    let engine = leg();
    let (statement, x) = logged(&engine);
    let mut f = facts(&x);
    f["amount_minor"] = "1".into();
    assert_eq!(
        engine.sign_export(&request(&statement, f)).unwrap_err(),
        EngineError::BadRequest("export.facts")
    );
    let mut r = request(&statement, facts(&x));
    r.typ = "sd+jwt".into();
    assert_eq!(
        engine.sign_export(&r).unwrap_err(),
        EngineError::BadRequest("export.typ")
    );
    let mut r = request(&statement, facts(&x));
    r.payload["keelson"]["profile"] = "ap2.unknown/1".into();
    assert_eq!(
        engine.sign_export(&r).unwrap_err(),
        EngineError::BadRequest("export.profile")
    );

    // A statement whose receipt another key signed.
    let other = Engine::booted_at(config(None), Some(root()), at(NOW - 1_000)).with_log_signer(
        Arc::new(LogSigner::new(
            vec![LogKey::new(ORIGIN, &Zeroizing::new([8; 32]), vec![])],
            Arc::new(Records::default()),
        )),
    );
    assert_eq!(
        other
            .sign_export(&request(&statement, facts(&x)))
            .unwrap_err(),
        EngineError::BadRequest("export.receipt")
    );
    assert_eq!(
        leg_b()
            .sign_export(&request(&statement, facts(&x)))
            .unwrap_err(),
        EngineError::BadRequest("export.leg")
    );
}

/// Sets `v` at a JSON pointer, creating the objects and arrays on the way.
fn set(target: &mut Value, pointer: &str, v: Value) {
    let mut at = target;
    let parts: Vec<&str> = pointer.split('/').skip(1).collect();
    for (i, part) in parts.iter().enumerate() {
        let last = i + 1 == parts.len();
        let next = if last {
            v.clone()
        } else if parts[i + 1].parse::<usize>().is_ok() {
            json!([])
        } else {
            json!({})
        };
        at = match part.parse::<usize>() {
            Ok(n) => {
                let a = at.as_array_mut().unwrap();
                while a.len() <= n {
                    a.push(Value::Null);
                }
                if last || a[n].is_null() {
                    a[n] = next;
                }
                &mut a[n]
            }
            Err(_) => {
                let o = at.as_object_mut().unwrap();
                if last || !o.contains_key(*part) {
                    o.insert((*part).to_string(), next);
                }
                o.get_mut(*part).unwrap()
            }
        };
    }
}

/// What a row's pointer must hold for the countersign the facts state.
fn bound(fact: &Value, transform: Option<&str>, x: &keelson_tee::wire::Countersigned) -> Value {
    match transform {
        None => fact.clone(),
        Some("Minor") => json!(x.countersign.amount.parse::<u64>().unwrap()),
        Some("UpperCurrency") => json!("USD"),
        Some("LowerCurrency") => json!("usd"),
        Some("StatusOfDecision") => {
            json!(if x.countersign.decision == "1" {
                "Success"
            } else {
                "Error"
            })
        }
        Some(other) => panic!("no test value for transform {other}"),
    }
}

#[test]
fn signs_every_profile_only_when_its_bound_pointers_hold() {
    let engine = leg();
    let (statement, x) = logged(&engine);
    let f = facts(&x);
    let profiles: Value =
        serde_json::from_str(include_str!("../src/export_bindings.json")).unwrap();
    assert_eq!(profiles.as_array().unwrap().len(), 10);
    for p in profiles.as_array().unwrap() {
        let name = p["profile"].as_str().unwrap();
        let mut r = request(&statement, f.clone());
        r.typ = p["typ"].as_str().unwrap().into();
        r.payload["keelson"]["profile"] = name.into();
        let rows = p["rows"].as_array().unwrap();
        for row in rows {
            let fact = &f[row["fact"].as_str().unwrap()];
            let v = bound(fact, row["transform"].as_str(), &x);
            set(&mut r.payload, row["pointer"].as_str().unwrap(), v);
        }
        assert!(
            engine.sign_export(&r).is_ok(),
            "{name} with its bound values"
        );
        for row in rows {
            let mut wrong = r.clone();
            set(
                &mut wrong.payload,
                row["pointer"].as_str().unwrap(),
                json!("not the fact"),
            );
            assert_eq!(
                engine.sign_export(&wrong).unwrap_err(),
                EngineError::BadRequest("export.binding"),
                "{name} {}",
                row["pointer"]
            );
        }
    }
}
