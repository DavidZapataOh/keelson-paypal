//! The token status list: leg A signs only a list that keeps every revocation, and both legs
//! refuse a revoked mandate's countersign.

mod common;

use common::*;
use keelson_mandate::{STATUS_URI, StatusRef};
use keelson_tee::status::{STATUS_BYTES, check_token, encode_list};
use keelson_tee::wire::{CountersignRequest, MandateIssued, StatusSignRequest};
use keelson_tee::{Engine, EngineError};

const IDX: u32 = 4_242;

fn list(revoked: &[u32]) -> String {
    let mut bits = vec![0u8; STATUS_BYTES];
    for i in revoked {
        bits[*i as usize / 8] |= 1 << (i % 8);
    }
    encode_list(&bits)
}

fn sign(engine: &Engine, revoked: &[u32], now: i64) -> Result<String, EngineError> {
    let r = StatusSignRequest {
        uri: STATUS_URI.into(),
        lst: list(revoked),
    };
    engine.sign_status(&r, at(now)).map(|s| s.token)
}

/// A mandate with an entry in the list, registered on `a`.
fn listed(a: &Engine) -> MandateIssued {
    let mut r = register_request();
    r.status_idx = Some(IDX);
    a.register_mandate(&r, at(NOW)).unwrap()
}

fn request(issued: &MandateIssued, n: u128, token: Option<String>) -> CountersignRequest {
    let mut r = countersign_request(issued, &CartFixture::demo(), request_id(n), None);
    r.status_list = token;
    r
}

#[test]
fn clearing_a_bit_is_refused() {
    let a = leg_a();
    sign(&a, &[1, IDX], NOW).unwrap();
    assert_eq!(
        sign(&a, &[1], NOW + 1).unwrap_err(),
        EngineError::Status("status_not_extending")
    );
    sign(&a, &[1, 2, IDX], NOW + 2).unwrap();
}

#[test]
fn a_listed_mandate_needs_the_current_list_and_is_countersigned_while_valid() {
    let a = leg_a();
    let issued = listed(&a);
    let token = sign(&a, &[1], NOW).unwrap();
    let issuer = jwk_of(&root().issuer_key());
    let status = StatusRef {
        idx: IDX,
        uri: STATUS_URI.into(),
    };
    assert!(check_token(&token, &issuer.verifying_key().unwrap(), &status, NOW + 10).is_ok());

    assert_eq!(
        a.countersign(&request(&issued, 1, None), at(NOW + 10))
            .unwrap_err(),
        EngineError::BadRequest("status_list")
    );
    let x = a
        .countersign(&request(&issued, 2, Some(token.clone())), at(NOW + 10))
        .unwrap();
    assert_eq!(x.countersign.decision, "1");

    // Leg B checks the issuer's signature and the bit, with no record of its own.
    let mut rb = request(&issued, 2, Some(token));
    rb.observation = Some(x.observation.clone());
    assert_eq!(
        leg_b().countersign(&rb, at(NOW + 10)).unwrap().digest.0,
        x.digest.0
    );
}

#[test]
fn revoked_mandate_refused_on_both_legs() {
    let a = leg_a();
    let issued = listed(&a);
    let token = sign(&a, &[IDX], NOW).unwrap();
    assert_eq!(
        a.countersign(&request(&issued, 3, Some(token.clone())), at(NOW + 10))
            .unwrap_err(),
        EngineError::Status("mandate_revoked")
    );
    let mut rb = request(&issued, 3, Some(token));
    rb.observation = Some(observation((NOW + 10) * 1000));
    assert_eq!(
        leg_b().countersign(&rb, at(NOW + 10)).unwrap_err(),
        EngineError::Status("mandate_revoked")
    );
}

#[test]
fn stale_list_refused_on_leg_a() {
    let a = leg_a();
    let issued = listed(&a);
    let older = sign(&a, &[], NOW).unwrap();
    sign(&a, &[IDX], NOW + 1).unwrap();
    // Still fresh and signed, but not the last list: it would hide the revocation.
    assert_eq!(
        a.countersign(&request(&issued, 4, Some(older)), at(NOW + 10))
            .unwrap_err(),
        EngineError::Status("status_stale")
    );
}

#[test]
fn an_old_list_or_another_issuer_is_refused() {
    let a = leg_a();
    let issued = listed(&a);
    let token = sign(&a, &[], NOW - 400).unwrap();
    assert_eq!(
        a.countersign(&request(&issued, 5, Some(token)), at(NOW + 10))
            .unwrap_err(),
        EngineError::BadRequest("status_list")
    );
}

#[test]
fn mandate_without_status_is_unchanged() {
    let a = leg_a();
    let issued = a.register_mandate(&register_request(), at(NOW)).unwrap();
    let x = a
        .countersign(&request(&issued, 6, None), at(NOW + 10))
        .unwrap();
    assert_eq!(x.countersign.decision, "1");
}
