//! The purchase statement a leg signs on countersign (RFC 9943 signed statement, ES256K).

mod common;

use alloy_primitives::Address;
use common::*;
use coset::{CborSerializable, CoseSign1, TaggedCborSerializable};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use keelson_tee::wire::{Hex, LegA, LegMeasurements, StatementRequest};
use keelson_tee::{Engine, EngineError, TeeKind};
use sha2::{Digest, Sha256};

const TDX_MEASUREMENT: [u8; 32] = [0x11; 32];
const NITRO_MEASUREMENT: [u8; 32] = [0x22; 32];

fn ask(leg_a: Option<LegA>) -> StatementRequest {
    StatementRequest {
        measurements: LegMeasurements {
            tdx: Hex(TDX_MEASUREMENT),
            nitro: Some(Hex(NITRO_MEASUREMENT)),
        },
        ref_salt: Some(Hex([0x33; 32])),
        leg_a,
    }
}

fn nitro_leg() -> Engine {
    let mut c = config(Some(jwk_of(&root().issuer_key())));
    c.tee_kind = TeeKind::Nitro;
    Engine::booted_at(c, None, at(NOW - 1_000))
}

/// The signer of an ES256K COSE_Sign1, found by trying both recovery ids against `kid`.
fn cose_signer(statement: &[u8]) -> (Address, CoseSign1) {
    let s = CoseSign1::from_tagged_slice(statement).expect("a tagged COSE_Sign1");
    let digest: [u8; 32] = Sha256::digest(s.tbs_data(b"")).into();
    let sig = Signature::from_slice(&s.signature).expect("r || s");
    assert_eq!(sig.normalize_s(), sig, "low S");
    let kid = Address::from_slice(&s.protected.header.key_id);
    for id in [0, 1] {
        if let Ok(k) =
            VerifyingKey::recover_from_prehash(&digest, &sig, RecoveryId::from_byte(id).unwrap())
        {
            if Address::from_raw_public_key(&k.to_sec1_point(false).as_bytes()[1..]) == kid {
                return (kid, s);
            }
        }
    }
    panic!("the statement is not signed by its kid");
}

fn legs_of(s: &CoseSign1) -> Vec<ciborium::Value> {
    let payload: ciborium::Value = ciborium::from_reader(s.payload.as_deref().unwrap()).unwrap();
    let map = payload.as_map().unwrap();
    let get = |k: i64| {
        map.iter()
            .find(|(key, _)| key.as_integer() == Some(k.into()))
            .map(|(_, v)| v.clone())
    };
    assert!(
        get(22).is_none(),
        "no payment reference without a PayPal order"
    );
    get(21).unwrap().as_array().unwrap().clone()
}

#[test]
fn leg_a_signs_a_degraded_statement_and_leg_b_the_two_leg_one() {
    let issued = register();
    let f = CartFixture::demo();
    let a = leg_a();
    let mut req = countersign_request(&issued, &f, request_id(40), None);
    req.statement = Some(ask(None));
    let x = a.countersign(&req, at(NOW + 10)).unwrap();
    let (signer, sa) = cose_signer(&x.statement.as_ref().expect("leg A's statement").0);
    assert_eq!(signer, x.signer);
    assert_eq!(legs_of(&sa).len(), 1);

    let b = nitro_leg();
    let mut rb = req.clone();
    rb.observation = Some(x.observation.clone());
    rb.statement = Some(ask(Some(LegA {
        signer: x.signer,
        signature: x.signature,
    })));
    let y = b.countersign(&rb, at(NOW + 10)).unwrap();
    let (signer, sb) = cose_signer(&y.statement.as_ref().expect("leg B's statement").0);
    assert_eq!(signer, y.signer);
    let legs = legs_of(&sb);
    assert_eq!(legs.len(), 2);
    assert_eq!(
        legs[0].as_array().unwrap()[2].as_bytes().unwrap(),
        &x.signature.0.to_vec()
    );
    assert_eq!(
        legs[1].as_array().unwrap()[3].as_bytes().unwrap(),
        &NITRO_MEASUREMENT.to_vec()
    );
    assert!(sb.to_vec().is_ok());
}

#[test]
fn leg_b_refuses_a_leg_a_signature_over_another_countersign() {
    let issued = register();
    let f = CartFixture::demo();
    let x = leg_a()
        .countersign(
            &countersign_request(&issued, &f, request_id(41), None),
            at(NOW + 10),
        )
        .unwrap();
    let mut rb = countersign_request(&issued, &f, request_id(41), Some(x.observation.clone()));
    let mut wrong = x.signature;
    wrong.0[5] ^= 1;
    rb.statement = Some(ask(Some(LegA {
        signer: x.signer,
        signature: wrong,
    })));
    let err = nitro_leg().countersign(&rb, at(NOW + 10)).unwrap_err();
    assert_eq!(err, EngineError::BadRequest("leg_a"));
}

#[test]
fn without_the_field_the_answer_is_what_it_was() {
    let issued = register();
    let f = CartFixture::demo();
    let x = leg_a()
        .countersign(
            &countersign_request(&issued, &f, request_id(42), None),
            at(NOW + 10),
        )
        .unwrap();
    assert!(x.statement.is_none());
    let json = serde_json::to_value(&x).unwrap();
    assert!(json.get("statement").is_none());
}
