mod common;

use std::sync::Arc;

use keelson_tee::wire::{
    CardAuthorizeRequest, CardAuthorized, CardNetworkAuthorization, Countersigned, MandateIssued,
    RegisterMandate,
};
use keelson_tee::{CARD_BITS, Engine, EngineError};
use serde_json::{Value, json};

use common::*;

fn bit(name: &str) -> u32 {
    1 << CARD_BITS.iter().find(|(n, _)| *n == name).unwrap().1
}

/// The demo mandate on the card rail: RunFast, a shoe store in the US.
fn to_card(m: &mut Value) {
    m["payment"]["rail"] = json!("card");
    for c in m["payment"]["constraints"].as_array_mut().unwrap() {
        if c["type"] == "payment.allowed_payees" {
            *c = json!({ "type": "payment.card_controls", "single_use": true, "mcc_table": "v1" });
        }
    }
    for c in m["checkout"]["constraints"].as_array_mut().unwrap() {
        if c["type"] == "checkout.allowed_merchants" {
            c["allowed"] = json!([
                { "id": "mrc_runfast", "name": "RunFast", "mcc": ["5661", "5941"], "country": "US" }
            ]);
        }
    }
}

/// Leg A with no PayPal reading: a card mandate needs none.
fn card_leg_a() -> Engine {
    Engine::booted_at(config(None), Some(root()), at(NOW - 1_000))
        .with_user_records(Arc::new(Records::default()))
}

struct Fixture {
    engine: Engine,
    mandate: RegisterMandate,
    allow: Countersigned,
}

fn allowed(edit: impl FnOnce(&mut Value)) -> Fixture {
    let engine = card_leg_a();
    let mandate = mandate_with(&sub(), &other_passkey(), edit);
    let issued: MandateIssued = engine.register_mandate(&mandate, at(NOW)).unwrap();
    let f = CartFixture::demo();
    let allow = engine
        .countersign(
            &countersign_request(&issued, &f, request_id(1), None),
            at(NOW + 10),
        )
        .unwrap();
    Fixture {
        engine,
        mandate,
        allow,
    }
}

fn network(id: &str, amount: i64, mcc: &str, country: &str) -> CardNetworkAuthorization {
    CardNetworkAuthorization {
        id: id.into(),
        amount_minor: amount,
        currency: "USD".into(),
        mcc: mcc.into(),
        merchant_name: "RUNFAST STORE 12".into(),
        merchant_country: country.into(),
        network_id: "000000000012345".into(),
    }
}

fn request(f: &Fixture, n: CardNetworkAuthorization) -> CardAuthorizeRequest {
    CardAuthorizeRequest {
        countersign: f.allow.countersign.clone(),
        signature: f.allow.signature,
        chain_id: None,
        payload_sd: f.mandate.payload_sd.clone(),
        disclosures: f.mandate.disclosures.clone(),
        authorization: n,
    }
}

fn mask(a: &CardAuthorized) -> u32 {
    a.authorization.failed_mask.parse().unwrap()
}

#[test]
fn a_card_mandate_is_countersigned_without_paypal() {
    let f = allowed(to_card);
    assert_eq!(f.allow.countersign.decision, "1");
    assert_eq!(f.allow.countersign.amount, "9400");
}

#[test]
fn a_paypal_mandate_still_needs_its_paypal_reading() {
    let engine = card_leg_a();
    let mandate = mandate_with(&sub(), &other_passkey(), |_| {});
    let issued = engine.register_mandate(&mandate, at(NOW)).unwrap();
    let err = engine
        .countersign(
            &countersign_request(&issued, &CartFixture::demo(), request_id(1), None),
            at(NOW + 10),
        )
        .unwrap_err();
    assert_eq!(err, EngineError::NotReady);
}

#[test]
fn approves_the_first_matching_authorization_once() {
    let f = allowed(to_card);
    let ok = f
        .engine
        .authorize_card(
            &request(&f, network("iauth_1", 9400, "5661", "US")),
            at(NOW + 20),
        )
        .unwrap();
    assert_eq!(ok.authorization.decision, "1");
    assert_eq!(mask(&ok), 0);
    assert_eq!(ok.signer, f.allow.signer);
    assert_eq!(ok.authorization.request_id, f.allow.countersign.request_id);
    assert_eq!(ok.authorization.countersign_digest, f.allow.digest);
    let signature = alloy_primitives::Signature::from_raw(&ok.signature.0).unwrap();
    let recovered = signature
        .recover_address_from_prehash(&ok.digest.0.into())
        .unwrap();
    assert_eq!(recovered, ok.signer);

    // A retry of the same authorization gets the same answer.
    let again = f
        .engine
        .authorize_card(
            &request(&f, network("iauth_1", 9400, "5661", "US")),
            at(NOW + 21),
        )
        .unwrap();
    assert_eq!(again, ok);

    // Any other authorization of the card is a second use.
    let second = f
        .engine
        .authorize_card(
            &request(&f, network("iauth_2", 100, "5661", "US")),
            at(NOW + 22),
        )
        .unwrap();
    assert_eq!(second.authorization.decision, "2");
    assert_eq!(mask(&second), bit("used"));
}

#[test]
fn declines_what_the_allow_does_not_cover() {
    let f = allowed(to_card);
    let cases = [
        (network("a", 9401, "5661", "US"), bit("amount")),
        (network("b", 0, "5661", "US"), bit("amount")),
        (network("c", 500, "5812", "US"), bit("mcc")),
        (network("d", 500, "5661", "CA"), bit("country")),
        (
            CardNetworkAuthorization {
                currency: "EUR".into(),
                ..network("e", 500, "5661", "US")
            },
            bit("currency"),
        ),
    ];
    for (n, want) in cases {
        let out = f
            .engine
            .authorize_card(&request(&f, n), at(NOW + 20))
            .unwrap();
        assert_eq!(out.authorization.decision, "2");
        assert_eq!(mask(&out), want);
    }
    // A declined attempt does not use the card.
    let ok = f
        .engine
        .authorize_card(&request(&f, network("f", 500, "5941", "US")), at(NOW + 20))
        .unwrap();
    assert_eq!(ok.authorization.decision, "1");
}

#[test]
fn declines_after_the_allow_expires() {
    let f = allowed(to_card);
    let expires: i64 = f.allow.countersign.expires_at.parse().unwrap();
    let out = f
        .engine
        .authorize_card(&request(&f, network("a", 100, "5661", "US")), at(expires))
        .unwrap();
    assert_eq!(mask(&out), bit("expired"));
}

#[test]
fn declines_an_allow_of_a_paypal_mandate() {
    let engine = leg_a();
    let mandate = register_request();
    let issued = engine.register_mandate(&mandate, at(NOW)).unwrap();
    let allow = engine
        .countersign(
            &countersign_request(&issued, &CartFixture::demo(), request_id(1), None),
            at(NOW + 10),
        )
        .unwrap();
    let f = Fixture {
        engine,
        mandate,
        allow,
    };
    let out = f
        .engine
        .authorize_card(&request(&f, network("a", 100, "5661", "US")), at(NOW + 20))
        .unwrap();
    assert_eq!(out.authorization.decision, "2");
    assert_ne!(mask(&out) & bit("rail"), 0);
}

#[test]
fn refuses_a_countersign_this_leg_did_not_sign() {
    let f = allowed(to_card);
    let other = allowed(to_card);
    let err = other
        .engine
        .authorize_card(&request(&f, network("a", 100, "5661", "US")), at(NOW + 20))
        .unwrap_err();
    assert_eq!(err, EngineError::BadRequest("signature"));
}

#[test]
fn refuses_a_mandate_the_countersign_does_not_name() {
    let f = allowed(to_card);
    let mut r = request(&f, network("a", 100, "5661", "US"));
    r.payload_sd["checkout"]["constraints"][0]["allowed"][0]["mcc"] = json!(["5661", "5812"]);
    let err = f.engine.authorize_card(&r, at(NOW + 20)).unwrap_err();
    assert_eq!(err, EngineError::BadRequest("mandate"));
}

#[test]
fn any_store_binds_the_code_and_country() {
    let f = {
        let engine = card_leg_a();
        let mandate = mandate_with(&sub(), &other_passkey(), |m| {
            to_card(m);
            m["checkout"]["constraints"][0]["allowed"] =
                json!([{ "id": "*", "name": "Any store", "mcc": ["5661"], "country": "US" }]);
        });
        let issued = engine.register_mandate(&mandate, at(NOW)).unwrap();
        let mut cart = CartFixture::demo();
        cart.raw["cart"]["merchant"] = json!("*");
        let allow = engine
            .countersign(
                &countersign_request(&issued, &cart, request_id(1), None),
                at(NOW + 10),
            )
            .unwrap();
        Fixture {
            engine,
            mandate,
            allow,
        }
    };
    assert_eq!(f.allow.countersign.decision, "1");
    let ok = f
        .engine
        .authorize_card(&request(&f, network("a", 100, "5661", "US")), at(NOW + 20))
        .unwrap();
    assert_eq!(ok.authorization.decision, "1");
}
