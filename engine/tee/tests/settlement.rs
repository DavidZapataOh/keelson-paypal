//! Card settlements signed from the issuer's raw answers (vectors: Lithic's OpenAPI examples).

mod common;

use common::*;
use keelson_tee::wire::{
    Base64, CardSettlementRequest, Hex, LegA, LegMeasurements, SettlementObservation,
};
use keelson_tee::{Engine, EngineError, TeeKind};
use serde_json::Value;
use sha2::{Digest, Sha256};

const TRANSACTION: &str = include_str!("vectors/lithic/transaction-settled.json");
const CARD: &str = include_str!("vectors/lithic/card.json");

fn nitro_leg() -> Engine {
    let mut c = config(Some(jwk_of(&root().issuer_key())));
    c.tee_kind = TeeKind::Nitro;
    Engine::booted_at(c, None, at(NOW - 1_000))
}

/// The issuer's answers for the card of purchase `id`.
fn reading(id: &str, edit: impl FnOnce(&mut Value)) -> SettlementObservation {
    let mut card: Value = serde_json::from_str(CARD).unwrap();
    card["memo"] = format!("Keelson {id}").into();
    let mut t: Value = serde_json::from_str(TRANSACTION).unwrap();
    edit(&mut t);
    SettlementObservation {
        transaction: Base64(serde_json::to_vec(&t).unwrap()),
        card: Base64(serde_json::to_vec(&card).unwrap()),
        observed_at: NOW as u64,
    }
}

fn request(id: ulid::Ulid, observation: Option<SettlementObservation>) -> CardSettlementRequest {
    let t: Value = serde_json::from_str(TRANSACTION).unwrap();
    CardSettlementRequest {
        request_id: id,
        transaction_token: t["token"].as_str().unwrap().into(),
        card_token: t["card_token"].as_str().unwrap().into(),
        issuer: "lithic".into(),
        parent: Hex([0x44; 32]),
        ref_salt: Hex([0x33; 32]),
        measurements: LegMeasurements {
            tdx: Hex([0x11; 32]),
            nitro: Some(Hex([0x22; 32])),
        },
        observation,
        leg_a: None,
        chain_id: None,
    }
}

#[test]
fn leg_a_signs_the_settlement_it_read_and_leg_b_signs_both() {
    let id = request_id(70);
    let observed = reading(&id.to_string(), |_| {});
    let a = leg_a()
        .card_settlement(&request(id, None), &observed)
        .unwrap();
    assert_eq!(a.settlement.settled_minor, "9400");
    assert_eq!(a.settlement.currency, "840");
    assert_eq!(a.settlement.status, "1");
    assert_eq!(
        a.settlement.transaction_hash.0,
        <[u8; 32]>::from(Sha256::digest(&observed.transaction.0))
    );
    assert_eq!(a.settlement.settled_at, "1691088150");

    let mut rb = request(id, Some(observed.clone()));
    rb.leg_a = Some(LegA {
        signer: a.signer,
        signature: a.signature,
    });
    let b = nitro_leg().card_settlement(&rb, &observed).unwrap();
    assert_eq!(b.digest, a.digest);
    assert_ne!(b.statement, a.statement);
}

#[test]
fn leg_b_refuses_leg_a_over_an_edited_reading() {
    let id = request_id(71);
    let observed = reading(&id.to_string(), |_| {});
    let a = leg_a()
        .card_settlement(&request(id, None), &observed)
        .unwrap();
    let edited = reading(&id.to_string(), |t| t["settled_amount"] = 9401.into());
    let mut rb = request(id, Some(edited.clone()));
    rb.leg_a = Some(LegA {
        signer: a.signer,
        signature: a.signature,
    });
    assert_eq!(
        nitro_leg().card_settlement(&rb, &edited).unwrap_err(),
        EngineError::BadRequest("settlement.amount")
    );
    let other = reading(&id.to_string(), |t| {
        t["updated"] = "2023-08-03T18:42:31Z".into()
    });
    let mut rb = request(id, Some(other.clone()));
    rb.leg_a = Some(LegA {
        signer: a.signer,
        signature: a.signature,
    });
    assert_eq!(
        nitro_leg().card_settlement(&rb, &other).unwrap_err(),
        EngineError::BadRequest("leg_a")
    );
}

#[test]
fn refuses_a_card_issued_for_another_purchase_or_a_pending_transaction() {
    let id = request_id(72);
    let foreign = reading(&request_id(73).to_string(), |_| {});
    assert_eq!(
        leg_a()
            .card_settlement(&request(id, None), &foreign)
            .unwrap_err(),
        EngineError::BadRequest("settlement.card")
    );
    let pending = reading(&id.to_string(), |t| t["status"] = "PENDING".into());
    assert_eq!(
        leg_a()
            .card_settlement(&request(id, None), &pending)
            .unwrap_err(),
        EngineError::BadRequest("settlement.status")
    );
}
