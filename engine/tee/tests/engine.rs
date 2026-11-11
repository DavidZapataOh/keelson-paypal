mod common;

use std::sync::Arc;
use std::thread;

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use keelson_mandate::decode_mandate;
use keelson_mandate::{
    OPEN_MANDATE_TYP, OpenMandateVerifyOptions, USER_CREDENTIAL_TYP, verify_credential,
};
use keelson_tee::wire::{Base64, CountersignRequest, Countersigned, RegisterMandate};
use keelson_tee::{
    BIT_CANON, Engine, EngineError, MANDATE_SALT_PURPOSE, Root, SealAad, TeeKind, UserRecords,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use common::*;

#[test]
fn registers_the_demo_mandate() {
    let r = register_request();
    let out = register();
    let root = root();
    let issuer = jwk_of(&root.issuer_key());
    let holder = jwk_of(&root.user_key(&r.sub));

    let l1 = verify_credential(&out.user_credential, USER_CREDENTIAL_TYP, &issuer, None).unwrap();
    assert_eq!(l1.claims["sub"], json!(r.sub));
    assert_eq!(l1.claims["cnf"]["jwk"]["x"], json!(holder.x));
    assert_eq!(l1.claims["cnf"]["jwk"]["y"], json!(holder.y));
    let m = keelson_mandate::decode_mandate(&r.payload_sd, &r.disclosures).unwrap();
    assert_eq!(l1.claims["cred"]["jwk"]["x"], m["user"]["cred"]["jwk"]["x"]);
    assert_eq!(l1.claims["cred"]["jwk"]["y"], m["user"]["cred"]["jwk"]["y"]);

    let mid = "01JBXG3K5N7Q9R2T4V6W8Y0Z1A";
    let opts = OpenMandateVerifyOptions {
        expected_aud: "keelson.finance".into(),
        expected_nonce: mid.into(),
        now: NOW,
        max_skew_sec: 60,
    };
    let l2 = verify_credential(&out.open_mandate, OPEN_MANDATE_TYP, &issuer, Some(&opts)).unwrap();
    assert_eq!(l2.claims["mid"], json!(mid));

    let m = expected_mandate_hash(&r);
    assert_eq!(out.mandate_hash.0, m);
    let aad = SealAad {
        purpose: MANDATE_SALT_PURPOSE,
        sub: Some(&r.sub),
        record: &m,
    };
    assert_eq!(root.unseal(&aad, &out.sealed_salt.0).unwrap(), r.salt);
}

#[test]
fn reuses_a_valid_user_credential_and_refuses_a_forged_one() {
    let engine = leg_a();
    let first = engine
        .register_mandate(&register_request(), at(NOW))
        .unwrap();

    let mut r = register_request();
    r.user_credential = Some(first.user_credential.clone());
    let again = engine.register_mandate(&r, at(NOW)).unwrap();
    assert_eq!(again.user_credential, first.user_credential);

    let other = Engine::booted_at(config(None), Some(Root::new(&[7; 32])), at(NOW))
        .with_user_records(Arc::new(Records::default()));
    let foreign = other
        .register_mandate(&register_request(), at(NOW))
        .unwrap();
    r.user_credential = Some(foreign.user_credential);
    let err = engine.register_mandate(&r, at(NOW)).unwrap_err();
    assert_eq!(err.code(), "auth.open_user_credential");
}

#[test]
fn refuses_a_salt_that_does_not_open_the_commitment() {
    let mut r = register_request();
    r.salt = [0; 16];
    let err = leg_a().register_mandate(&r, at(NOW)).unwrap_err();
    assert_eq!(err, EngineError::CommitmentMismatch);
    assert_eq!(err.code(), "commitment_mismatch");
}

#[test]
fn refuses_a_tampered_client_data_json() {
    let mut r = register_request();
    let mut client_data: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(&r.assertion.client_data_json)
            .unwrap(),
    )
    .unwrap();
    client_data["origin"] = json!("https://evil.example");
    r.assertion.client_data_json = b64u(client_data.to_string());
    let err = leg_a().register_mandate(&r, at(NOW)).unwrap_err();
    assert!(err.code().starts_with("auth.webauthn_"), "{}", err.code());
}

#[test]
fn an_engine_without_a_root_does_not_register() {
    let err = leg_b()
        .register_mandate(&register_request(), at(NOW))
        .unwrap_err();
    assert_eq!(err, EngineError::NoRoot);
    assert_eq!(err.code(), "no_root");
}

#[test]
fn allows_the_demo_cart() {
    let issued = register();
    let f = CartFixture::demo();
    let id = request_id(1);
    let engine = leg_a();
    let out = engine
        .countersign(&countersign_request(&issued, &f, id, None), at(NOW + 10))
        .unwrap();

    let c = &out.countersign;
    assert_eq!(c.decision, "1");
    assert_eq!(mask(&out), 0);
    assert_eq!(c.amount, "9400");
    assert_eq!(c.currency, "840");
    assert_eq!(c.category, "21");
    assert_eq!(c.agent_id, "42");
    assert_eq!(c.issued_at, (NOW + 10).to_string());
    assert_eq!(c.expires_at, (NOW + 910).to_string());
    assert_eq!(c.cart_hash.0, f.hash());
    assert_eq!(c.mandate_hash.0, issued.mandate_hash.0);
    assert_eq!(c.request_id.0[..16], [0; 16]);
    assert_eq!(c.request_id.0[16..], id.to_bytes());
    assert_eq!(c.evidence_root.0, [0x55; 32]);
    let eval: [u8; 32] = Sha256::new()
        .chain_update(b"keelson/eval/v1\0")
        .chain_update(&out.trace_jcs.0)
        .finalize()
        .into();
    assert_eq!(c.eval_hash.0, eval);
    assert_eq!(c.policy_set_hash.0, keelson_policy::policy_set_hash());
    assert_eq!(trace(&out)["decision"], "allow");

    assert_eq!(out.signer, engine.signer());
    assert_eq!(recover(&out), engine.signer());
    assert_eq!(out.tee, TeeKind::Tdx);
    assert_eq!(out.observation.now_ms, (NOW + 10) * 1000);
    assert_eq!(out.observation.budget_left_minor, 10_000);
    assert_eq!(out.observation.user_key, jwk_of(&root().user_key(&sub())));

    // Another leg A over the same request signs the same digest.
    let again = leg_a()
        .countersign(&countersign_request(&issued, &f, id, None), at(NOW + 10))
        .unwrap();
    assert_eq!(again.digest.0, out.digest.0);
    assert_eq!(again.trace_jcs.0, out.trace_jcs.0);
}

#[test]
fn denies_the_340_bundle_on_amount() {
    let issued = register();
    let out = leg_a()
        .countersign(
            &countersign_request(&issued, &CartFixture::bundle(), request_id(2), None),
            at(NOW + 10),
        )
        .unwrap();
    assert_eq!(out.countersign.decision, "2");
    assert_ne!(mask(&out) & BIT_AMOUNT, 0);
    assert_eq!(out.countersign.amount, "34000");
    let trace = trace(&out);
    let amount = trace["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["id"] == "amount")
        .unwrap();
    assert_eq!(amount["observed"], 34_000);
    assert_eq!(amount["pass"], false);
}

#[test]
fn denies_a_breakdown_mismatch_as_a_canonicalizer_deny() {
    let issued = register();
    let out = leg_a()
        .countersign(
            &countersign_request(
                &issued,
                &CartFixture::breakdown_mismatch(),
                request_id(3),
                None,
            ),
            at(NOW + 10),
        )
        .unwrap();
    assert_eq!(out.countersign.decision, "2");
    assert_eq!(mask(&out), 1 << BIT_CANON);
    let trace = trace(&out);
    assert_eq!(trace["decision"], "deny");
    assert_eq!(trace["errors"], json!(["canon.amount_breakdown_mismatch"]));
    assert_eq!(recover(&out), out.signer);
}

#[test]
fn refuses_a_key_binding_for_another_request() {
    let issued = register();
    let f = CartFixture::demo();
    let mut r = countersign_request(&issued, &f, request_id(4), None);
    r.closed_mandate = close(
        &issued.open_mandate,
        &request_id(5).to_string(),
        &f.hash(),
        NOW,
    );
    let err = leg_a().countersign(&r, at(NOW + 10)).unwrap_err();
    assert_eq!(err.code(), "auth.closed_nonce");
}

#[test]
fn refuses_a_cart_other_than_the_one_bound() {
    let issued = register();
    let mut r = countersign_request(&issued, &CartFixture::demo(), request_id(6), None);
    r.cart.lines[0].qty = 2;
    let err = leg_a().countersign(&r, at(NOW + 10)).unwrap_err();
    assert_eq!(err.code(), "auth.closed_cart_hash");
}

#[test]
fn refuses_a_credential_held_by_another_user() {
    let issued = register();
    let mut r = countersign_request(&issued, &CartFixture::demo(), request_id(7), None);
    r.sub = "a".into();
    let err = leg_a().countersign(&r, at(NOW + 10)).unwrap_err();
    assert_eq!(err, EngineError::Auth("open_holder".into()));
    assert_eq!(err.code(), "auth.open_holder");
}

/// An observation may be as old as the skew tolerated on the mandate's times, so a retry served
/// from leg A's record still verifies, but never more than two seconds ahead of this leg.
#[test]
fn refuses_an_observation_off_the_clock() {
    let issued = register();
    let f = CartFixture::demo();
    let clock = NOW + 10;
    for (skew, ok) in [
        (2_000, true),
        (2_001, false),
        (-2_000, true),
        (-60_000, true),
        (-60_001, false),
    ] {
        let r = countersign_request(
            &issued,
            &f,
            request_id(8),
            Some(observation(clock * 1000 + skew)),
        );
        let result = leg_b().countersign(&r, at(clock));
        match ok {
            true => assert_eq!(result.unwrap().countersign.decision, "1", "{skew}"),
            false => assert_eq!(result.unwrap_err(), EngineError::Clock, "{skew}"),
        }
    }
    assert_eq!(EngineError::Clock.code(), "clock_skew");
}

/// Leg A produces the observation; one from the caller would let it skip the ledger.
#[test]
fn leg_a_refuses_a_caller_supplied_observation() {
    let issued = register();
    let f = CartFixture::sixty();
    let engine = leg_a_at(NOW, 0);
    for n in 0..5 {
        let mut forged = observation((NOW + 10) * 1000);
        forged.budget_left_minor = i64::MAX;
        let r = countersign_request(&issued, &f, request_id(200 + n), Some(forged));
        let err = engine.countersign(&r, at(NOW + 10)).unwrap_err();
        assert_eq!(err, EngineError::BadRequest("observation"));
        assert_eq!(err.code(), "bad_request");
    }
    // Without one, the warm-up still holds.
    let r = countersign_request(&issued, &f, request_id(205), None);
    let out = engine.countersign(&r, at(NOW + 10)).unwrap();
    assert_eq!(out.countersign.decision, "2");
    assert_eq!(mask(&out), BIT_BUDGET);
}

#[test]
fn leg_a_counts_what_its_own_paypal_read_captured() {
    let issued = register();
    let f = CartFixture::demo();
    let out = leg_a_at(NOW - 1_000, 1_000)
        .countersign(
            &countersign_request(&issued, &f, request_id(20), None),
            at(NOW + 10),
        )
        .unwrap();
    assert_eq!(out.countersign.decision, "2");
    assert_eq!(mask(&out), BIT_BUDGET);
    assert_eq!(out.observation.budget_left_minor, 9_000);
}

#[test]
fn leg_a_without_a_captured_amount_is_not_ready() {
    let issued = register();
    let r = countersign_request(&issued, &CartFixture::demo(), request_id(21), None);
    let bare = Engine::booted_at(config(None), Some(root()), at(NOW - 1_000));
    assert_eq!(
        bare.countersign(&r, at(NOW + 10)).unwrap_err(),
        EngineError::NotReady
    );
    assert_eq!(EngineError::NotReady.code(), "not_ready");

    // A source that has not read this mandate yet.
    let unread = Engine::booted_at(config(None), Some(root()), at(NOW - 1_000)).with_captured(
        Arc::new(Captured {
            mandate_hash: [0; 32],
            minor: 0,
        }),
    );
    assert_eq!(
        unread.countersign(&r, at(NOW + 10)).unwrap_err(),
        EngineError::NotReady
    );
}

#[test]
fn registers_only_on_the_configured_origin() {
    let mut cfg = config(None);
    cfg.origin = "https://app.keelson.finance".into();
    let engine = Engine::booted_at(cfg, Some(root()), at(NOW))
        .with_user_records(Arc::new(Records::default()));
    let err = engine
        .register_mandate(&register_request(), at(NOW))
        .unwrap_err();
    assert_eq!(err.code(), "auth.webauthn_origin");
}

#[test]
fn registers_only_for_the_pinned_rp_id() {
    let mut r = mandate_for(&sub(), &other_passkey());
    let mut m = r.payload_sd.clone();
    m["user"]["cred"]["rp_id"] = json!("evil.example");
    r.payload_sd = m;
    let err = leg_a().register_mandate(&r, at(NOW)).unwrap_err();
    assert_eq!(err.code(), "auth.webauthn_rp_id");
}

/// Any passkey the caller registered to a user signs their mandates, each with its own user
/// credential; a user credential vouches only for the passkey it names.
#[test]
fn every_passkey_of_a_user_signs_with_its_own_user_credential() {
    let engine = leg_a();
    let first = engine
        .register_mandate(&register_request(), at(NOW))
        .unwrap();
    let second = engine
        .register_mandate(&mandate_for(&sub(), &other_passkey()), at(NOW))
        .unwrap();
    assert_ne!(second.user_credential, first.user_credential);

    let mut again = mandate_for(&sub(), &other_passkey());
    again.user_credential = Some(second.user_credential.clone());
    let reused = engine.register_mandate(&again, at(NOW)).unwrap();
    assert_eq!(reused.user_credential, second.user_credential);

    let mut swapped = mandate_for(&sub(), &other_passkey());
    swapped.user_credential = Some(first.user_credential.clone());
    let err = engine.register_mandate(&swapped, at(NOW)).unwrap_err();
    assert_eq!(err.code(), "auth.open_user_credential");

    // The same key under another credential id is another passkey.
    let mut renamed = mandate_with(&sub(), &other_passkey(), |m| {
        m["user"]["cred"]["id"] = json!("cmVuYW1lZA");
    });
    renamed.user_credential = Some(second.user_credential.clone());
    let err = engine.register_mandate(&renamed, at(NOW)).unwrap_err();
    assert_eq!(err.code(), "auth.open_user_credential");

    let mut stolen = mandate_for("kls_usr_other", &other_passkey());
    stolen.user_credential = Some(second.user_credential);
    let err = engine.register_mandate(&stolen, at(NOW)).unwrap_err();
    assert_eq!(err.code(), "auth.open_user_credential");
}

/// The same request, with the same cart, is answered once; a different cart is a replay.
#[test]
fn a_request_id_is_countersigned_once() {
    let issued = register();
    let f = CartFixture::sixty();
    let engine = leg_a();
    let first = engine
        .countersign(
            &countersign_request(&issued, &f, request_id(30), None),
            at(NOW + 10),
        )
        .unwrap();
    assert_eq!(first.countersign.decision, "1");
    let again = engine
        .countersign(
            &countersign_request(&issued, &f, request_id(30), None),
            at(NOW + 20),
        )
        .unwrap();
    assert_eq!(again, first);

    // Only one $60 was reserved.
    let next = engine
        .countersign(
            &countersign_request(&issued, &f, request_id(31), None),
            at(NOW + 20),
        )
        .unwrap();
    assert_eq!(next.countersign.decision, "2");
    assert_eq!(next.observation.budget_left_minor, 4_000);

    let other = CartFixture::demo();
    let err = engine
        .countersign(
            &countersign_request(&issued, &other, request_id(30), None),
            at(NOW + 20),
        )
        .unwrap_err();
    assert_eq!(err, EngineError::Replay);
    assert_eq!(err.code(), "replay");
}

/// A request that fails once authenticated leaves the budget as it was.
#[test]
fn a_failed_request_reserves_nothing() {
    let issued = register();
    let engine = leg_a();
    let mut f = CartFixture::sixty();
    f.raw["cart"]["merchant"] = json!("");
    let err = engine
        .countersign(
            &countersign_request(&issued, &f, request_id(40), None),
            at(NOW + 10),
        )
        .unwrap_err();
    assert_eq!(err.code(), "bad_request");
    let out = engine
        .countersign(
            &countersign_request(&issued, &CartFixture::demo(), request_id(41), None),
            at(NOW + 10),
        )
        .unwrap();
    assert_eq!(out.countersign.decision, "1");
    assert_eq!(out.observation.budget_left_minor, 10_000);
}

#[test]
fn refuses_evidence_only_engine_verifiers_may_supply() {
    let issued = register();
    let mut r = countersign_request(&issued, &CartFixture::demo(), request_id(9), None);
    r.evidence
        .insert("amount".into(), vec!["zktls:forged".into()]);
    let err = leg_a().countersign(&r, at(NOW + 10)).unwrap_err();
    assert_eq!(err.code(), "bad_request");
}

#[test]
fn leg_b_needs_the_observation() {
    let issued = register();
    let r = countersign_request(&issued, &CartFixture::demo(), request_id(10), None);
    let err = leg_b().countersign(&r, at(NOW + 10)).unwrap_err();
    assert_eq!(err.code(), "bad_request");
}

/// Leg B, fed leg A's observation, agrees with leg A on everything but the signature.
#[test]
fn two_legs_sign_the_same_digest() {
    let issued = register();
    let clock = NOW + 10;
    let r = countersign_request(&issued, &CartFixture::demo(), request_id(11), None);
    let mut first: Option<Countersigned> = None;
    for _ in 0..1_000 {
        let (a, b) = (leg_a(), leg_b());
        let x = a.countersign(&r, at(clock)).unwrap();
        let mut rb = r.clone();
        rb.observation = Some(x.observation.clone());
        let y = b.countersign(&rb, at(clock)).unwrap();
        let first = first.get_or_insert_with(|| x.clone());
        assert_eq!(first.countersign.decision, "1");
        for out in [&x, &y] {
            assert_eq!(out.digest.0, first.digest.0);
            assert_eq!(out.trace_jcs.0, first.trace_jcs.0);
        }
        assert_ne!(x.signature.0, y.signature.0);
        assert_eq!(recover(&x), a.signer());
        assert_eq!(recover(&y), b.signer());
        assert_ne!(a.signer(), b.signer());
    }
}

/// Concurrent requests never reserve past the budget.
#[test]
fn reserves_the_budget_exactly_once_under_contention() {
    let issued = register();
    let engine = Arc::new(leg_a());
    let f = CartFixture::sixty();
    let requests: Vec<_> = (0..32)
        .map(|i| countersign_request(&issued, &f, request_id(100 + i), None))
        .collect();
    let outs: Vec<Countersigned> = thread::scope(|s| {
        let handles: Vec<_> = requests
            .iter()
            .map(|r| {
                let engine = Arc::clone(&engine);
                s.spawn(move || engine.countersign(r, at(NOW + 10)).unwrap())
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let allowed: Vec<_> = outs
        .iter()
        .filter(|o| o.countersign.decision == "1")
        .collect();
    assert_eq!(allowed.len(), 1);
    for denied in outs.iter().filter(|o| o.countersign.decision == "2") {
        assert_eq!(mask(denied), BIT_BUDGET);
        assert_eq!(denied.observation.budget_left_minor, 4_000);
    }
}

/// Reservations live only in RAM, so a fresh engine allows nothing until every reservation an
/// earlier boot could have made has expired.
#[test]
fn allows_nothing_in_the_first_900_seconds_after_boot() {
    let issued = register();
    let f = CartFixture::demo();
    let engine = leg_a_at(NOW, 0);
    let at_clock = |n: u128, clock: i64| {
        countersign_at(&engine, &issued, &f, request_id_at(n, clock * 1000), clock).unwrap()
    };
    let early = at_clock(12, NOW + 899);
    assert_eq!(early.countersign.decision, "2");
    assert_eq!(mask(&early), BIT_BUDGET);
    assert_eq!(early.observation.budget_left_minor, 0);
    let late = at_clock(13, NOW + 900);
    assert_eq!(late.countersign.decision, "1");
}

#[test]
fn wire_types_round_trip_as_json() {
    let issued = register();
    let r = countersign_request(
        &issued,
        &CartFixture::demo(),
        request_id(14),
        Some(observation((NOW + 10) * 1000)),
    );
    let json = serde_json::to_value(&r).unwrap();
    assert_eq!(json["evidence_root"], format!("0x{}", "55".repeat(32)));
    let back: CountersignRequest = serde_json::from_value(json).unwrap();
    let out = leg_b().countersign(&back, at(NOW + 10)).unwrap();
    let json = serde_json::to_value(&out).unwrap();
    assert_eq!(json["countersign"]["decision"], "1");
    assert_eq!(
        STANDARD
            .decode(json["trace_jcs"].as_str().unwrap())
            .unwrap(),
        out.trace_jcs.0
    );
    let back: Countersigned = serde_json::from_value(json).unwrap();
    assert_eq!(back.digest.0, out.digest.0);
    let _: Base64 = serde_json::from_value(json!("AA==")).unwrap();
}

/// Two carts racing under one request id: at most one is answered, and what is reserved is
/// exactly what was allowed.
#[test]
fn racing_carts_under_one_request_id_never_overspend() {
    let issued = register();
    let (small, large) = (CartFixture::sixty(), CartFixture::demo());
    let id = request_id(50);
    let requests = [
        countersign_request(&issued, &small, id, None),
        countersign_request(&issued, &large, id, None),
    ];
    for i in 0..1_000 {
        let engine = leg_a();
        let barrier = std::sync::Barrier::new(2);
        let outs: Vec<_> = thread::scope(|s| {
            let handles: Vec<_> = requests
                .iter()
                .map(|r| {
                    let (engine, barrier) = (&engine, &barrier);
                    s.spawn(move || {
                        barrier.wait();
                        engine.countersign(r, at(NOW + 10))
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let allowed: i64 = outs
            .iter()
            .filter_map(|o| o.as_ref().ok())
            .filter(|o| o.countersign.decision == "1")
            .map(|o| o.countersign.amount.parse::<i64>().unwrap())
            .sum();
        let summary: Vec<_> = outs
            .iter()
            .map(|o| {
                o.as_ref()
                    .map(|o| (&o.countersign.decision, &o.countersign.amount))
            })
            .collect();
        let answered = outs.iter().filter(|o| o.is_ok()).count();
        assert_eq!(answered, 1, "iter {i}: {summary:?}");
        for o in outs.iter().filter_map(|o| o.as_ref().err()) {
            assert_eq!(*o, EngineError::Replay, "iter {i}");
        }
        let probe = engine
            .countersign(
                &countersign_request(&issued, &small, request_id(51), None),
                at(NOW + 10),
            )
            .unwrap();
        let left = probe.observation.budget_left_minor;
        assert_eq!(left, 10_000 - allowed, "iter {i}: {summary:?}");
    }
}

/// One cart under two PayPal units racing under one request id: the answer and the reservation
/// always agree.
#[test]
fn racing_units_under_one_request_id_reserve_what_is_signed() {
    let issued = register();
    let sixty = CartFixture::sixty();
    let mut shipped = CartFixture::sixty();
    shipped.raw["unit"]["amount"]["value"] = json!("94.00");
    shipped.raw["unit"]["amount"]["breakdown"]["shipping"] =
        json!({ "currency_code": "USD", "value": "34.00" });
    let id = request_id(60);
    let requests: Vec<_> = (0..8)
        .map(|n| {
            let f = if n % 2 == 0 { &sixty } else { &shipped };
            countersign_request(&issued, f, id, None)
        })
        .collect();
    // The same cart, so the same key binding: only the unit differs.
    assert_eq!(requests[0].closed_mandate, requests[1].closed_mandate);
    for i in 0..1_500 {
        let engine = leg_a();
        let barrier = std::sync::Barrier::new(requests.len());
        let outs: Vec<_> = thread::scope(|s| {
            let handles: Vec<_> = requests
                .iter()
                .map(|r| {
                    let (engine, barrier) = (&engine, &barrier);
                    s.spawn(move || {
                        barrier.wait();
                        engine.countersign(r, at(NOW + 10))
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let answers: Vec<&Countersigned> = outs.iter().filter_map(|o| o.as_ref().ok()).collect();
        assert!(!answers.is_empty(), "iter {i}");
        assert!(answers.iter().all(|a| *a == answers[0]), "iter {i}");
        for e in outs.iter().filter_map(|o| o.as_ref().err()) {
            assert_eq!(*e, EngineError::Replay, "iter {i}");
        }
        let signed = match answers[0].countersign.decision.as_str() {
            "1" => answers[0].countersign.amount.parse::<i64>().unwrap(),
            _ => 0,
        };
        let probe = engine
            .countersign(
                &countersign_request(&issued, &CartFixture::demo(), request_id(61), None),
                at(NOW + 10),
            )
            .unwrap();
        assert_eq!(
            probe.observation.budget_left_minor,
            10_000 - signed,
            "iter {i}: signed {signed}"
        );
    }
}

/// A reservation is held for the whole signed validity: through the second `expiresAt` and
/// freed only after it.
#[test]
fn a_reservation_is_held_through_its_expiry_second() {
    let issued = register();
    let engine = leg_a();
    let id = request_id_at(70, (NOW + 10) * 1000);
    let first = countersign_at(&engine, &issued, &CartFixture::sixty(), id, NOW + 10).unwrap();
    assert_eq!(first.countersign.decision, "1");
    let expires: i64 = first.countersign.expires_at.parse().unwrap();
    let probe = |n: u128, clock: i64| {
        let id = request_id_at(n, clock * 1000);
        countersign_at(&engine, &issued, &CartFixture::demo(), id, clock).unwrap()
    };

    // At `expiresAt` the countersign is still valid, so the $60 is still reserved.
    let still = probe(71, expires);
    assert_eq!(still.countersign.decision, "2");
    assert_eq!(still.observation.budget_left_minor, 4_000);
    // The same id with another cart is still a replay.
    let err = countersign_at(&engine, &issued, &CartFixture::demo(), id, expires).unwrap_err();
    assert_eq!(err, EngineError::Replay);

    // A second later it is freed.
    let freed = probe(72, expires + 1);
    assert_eq!(freed.countersign.decision, "1");
    assert_eq!(freed.observation.budget_left_minor, 10_000);
}

/// A request id is accepted only while a record for it could still be live, so it is never
/// signed again after its record expires.
#[test]
fn request_ids_are_accepted_only_within_their_lifetime() {
    let issued = register();
    let clock = NOW + 1_000;
    let now_ms = clock * 1000;
    // The oldest id still accepted is one millisecond inside `TTL − skew`.
    let oldest = now_ms - (900 - 60) * 1000;
    let cases = [
        (oldest + 1, true),
        (oldest, false),
        (now_ms + 60_000, true),
        (now_ms + 60_001, false),
    ];
    for (n, (ms, ok)) in cases.into_iter().enumerate() {
        let id = request_id_at(80 + n as u128, ms);
        let result = countersign_at(&leg_a(), &issued, &CartFixture::demo(), id, clock);
        match ok {
            true => assert!(result.is_ok(), "{ms}: {:?}", result.err()),
            false => assert_eq!(result.err(), Some(EngineError::Replay), "{ms}"),
        }
    }

    // The id of an expired countersign is refused, not signed again.
    let engine = leg_a();
    let id = request_id_at(90, (NOW + 10) * 1000);
    let first = countersign_at(&engine, &issued, &CartFixture::sixty(), id, NOW + 10).unwrap();
    let expires: i64 = first.countersign.expires_at.parse().unwrap();
    let again = countersign_at(&engine, &issued, &CartFixture::sixty(), id, expires + 1);
    assert_eq!(again.err(), Some(EngineError::Replay));
}

/// During warm-up a $0 cart on a mandate captured past its max is answered once, not retried.
#[test]
fn a_zero_cart_in_warm_up_over_captured_returns() {
    let issued = register();
    let mut free = CartFixture::demo();
    free.raw["cart"]["lines"][0]["unit_minor"] = json!(0);
    free.raw["unit"]["amount"]["value"] = json!("0.00");
    free.raw["unit"]["amount"]["breakdown"]["item_total"]["value"] = json!("0.00");
    for (boot, captured) in [(NOW, 10_001), (NOW, 0), (NOW - 1_000, 10_001)] {
        let r = countersign_request(&issued, &free, request_id(100), None);
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let out = leg_a_at(boot, captured).countersign(&r, at(NOW + 10));
            let _ = tx.send(out);
        });
        let out = rx
            .recv_timeout(std::time::Duration::from_secs(30))
            .expect("countersign returns")
            .unwrap();
        let expected = if captured > 10_000 { "2" } else { "1" };
        assert_eq!(
            out.countersign.decision, expected,
            "boot {boot}, captured {captured}"
        );
    }
}

fn demo_mandate_times() -> (i64, i64) {
    let r = register_request();
    let m = decode_mandate(&r.payload_sd, &r.disclosures).unwrap();
    (m["nbf"].as_i64().unwrap(), m["exp"].as_i64().unwrap())
}

#[test]
fn refuses_to_register_an_expired_or_not_yet_valid_mandate() {
    let (nbf, exp) = demo_mandate_times();
    let engine = leg_a();
    let r = register_request();
    assert_eq!(
        engine.register_mandate(&r, at(exp)).unwrap_err(),
        EngineError::Expired
    );
    assert_eq!(
        engine.register_mandate(&r, at(nbf - 1)).unwrap_err(),
        EngineError::NotYetValid
    );
    engine.register_mandate(&r, at(nbf)).unwrap();
    engine.register_mandate(&r, at(exp - 1)).unwrap();
}

#[test]
fn rejects_oversized_register_inputs() {
    let engine = leg_a();
    let too_large = |r: RegisterMandate| {
        let err = engine.register_mandate(&r, at(NOW)).unwrap_err();
        assert!(matches!(err, EngineError::TooLarge(_)), "{err:?}");
        assert_eq!(err.code(), "payload_too_large");
    };
    let base = register_request;

    let mut r = base();
    r.sub = "u".repeat(129);
    too_large(r);
    let mut r = base();
    r.disclosures = vec!["a".to_owned(); 513];
    too_large(r);
    let mut r = base();
    r.disclosures.push("a".repeat(4097));
    too_large(r);
    let mut r = base();
    r.assertion.signature = "a".repeat(4097);
    too_large(r);
    let mut r = base();
    r.user_credential = Some("a".repeat(128 * 1024 + 1));
    too_large(r);
    let mut r = base();
    r.payload_sd["pad"] = json!("a".repeat(128 * 1024));
    too_large(r);
}

#[test]
fn rejects_oversized_countersign_inputs() {
    let engine = leg_a();
    let issued = register();
    let f = CartFixture::demo();
    let too_large = |r: CountersignRequest| {
        let err = engine.countersign(&r, at(NOW)).unwrap_err();
        assert!(matches!(err, EngineError::TooLarge(_)), "{err:?}");
    };
    let base = || countersign_request(&issued, &f, request_id(1), None);

    let mut r = base();
    r.closed_mandate = "a".repeat(128 * 1024 + 1);
    too_large(r);
    let mut r = base();
    r.sub = "u".repeat(129);
    too_large(r);
    let mut r = base();
    r.cart.lines = vec![r.cart.lines[0].clone(); 65];
    too_large(r);
    let mut r = base();
    r.cart.lines[0].sku = "s".repeat(257);
    too_large(r);
    let mut r = base();
    r.cart.merchant = "m".repeat(257);
    too_large(r);
    let mut r = base();
    r.unit.value = "1".repeat(257);
    too_large(r);
    let mut r = base();
    r.evidence
        .insert("merchant".to_owned(), vec!["e".to_owned(); 17]);
    too_large(r);
    let mut r = base();
    r.evidence
        .insert("merchant".to_owned(), vec!["e".repeat(257)]);
    too_large(r);
    let mut r = base();
    for i in 0..17 {
        r.evidence.insert(format!("field{i}"), Vec::new());
    }
    too_large(r);
}

#[test]
fn binding_carries_the_boot_configuration() {
    let engine = leg_a();
    let b = engine.binding().unwrap();
    assert_eq!(b.chain_id, 421_614);
    assert_eq!(b.bond_vault, alloy_primitives::Address::ZERO);
    assert_eq!(b.tee_kind, TeeKind::Tdx);
    assert_eq!(b.signer, engine.signer());
    assert_eq!(b.policy_set_hash, keelson_policy::policy_set_hash());
    assert_eq!(b.engine_build_id, [0xab; 32]);
    assert_eq!(b.boot_epoch, engine.boot_epoch());
    assert_eq!(
        b.issuer_jwk_thumbprint,
        jwk_of(&root().issuer_key()).thumbprint()
    );
}

#[test]
fn both_legs_bind_the_issuer_key() {
    assert_eq!(
        leg_a().binding().unwrap().issuer_jwk_thumbprint,
        leg_b().binding().unwrap().issuer_jwk_thumbprint
    );
    let other = jwk_of(&Root::new(&[9; 32]).issuer_key());
    let engine = Engine::booted_at(config(Some(other.clone())), None, at(NOW));
    assert_eq!(
        engine.binding().unwrap().issuer_jwk_thumbprint,
        other.thumbprint()
    );
}

#[test]
fn binding_needs_an_issuer_key() {
    let engine = Engine::booted_at(config(None), None, at(NOW));
    assert_eq!(engine.binding(), Err(keelson_tee::Error::NoIssuer));
}

#[test]
fn binding_needs_a_sha256_image_digest() {
    for digest in [
        "latest".to_owned(),
        format!("sha512:{}", "ab".repeat(32)),
        format!("sha256:{}", "AB".repeat(32)),
        format!("sha256:{}", "ab".repeat(31)),
    ] {
        let mut config = config(None);
        config.oci_digest = digest;
        let engine = Engine::booted_at(config, Some(root()), at(NOW));
        assert_eq!(engine.binding(), Err(keelson_tee::Error::OciDigest));
    }
}

#[test]
fn one_signer_countersigns_under_the_domain_of_the_requested_chain() {
    let issued = register();
    let f = CartFixture::demo();
    let engine = leg_a();
    let mut one = countersign_request(&issued, &f, request_id(1), None);
    one.chain_id = Some(42_161);
    let out = engine.countersign(&one, at(NOW + 10)).unwrap();
    assert_eq!(recover(&out), engine.signer());
    let mut sepolia = countersign_request(&issued, &f, request_id(2), None);
    sepolia.chain_id = Some(421_614);
    let other = engine.countersign(&sepolia, at(NOW + 10)).unwrap();
    // Same message fields, other domain: the digests differ only by chain.
    assert_ne!(out.digest.0, other.digest.0);

    let mut unsupported = countersign_request(&issued, &f, request_id(3), None);
    unsupported.chain_id = Some(1);
    assert_eq!(
        engine.countersign(&unsupported, at(NOW + 10)).err(),
        Some(EngineError::BadRequest("chain_id"))
    );
}

#[test]
fn a_request_id_is_answered_once_across_mandates() {
    let issued = register();
    let f = CartFixture::demo();
    let engine = leg_a();
    let id = request_id(1);
    engine
        .countersign(&countersign_request(&issued, &f, id, None), at(NOW + 10))
        .unwrap();
    let mut again = countersign_request(&issued, &f, id, None);
    again.chain_id = Some(42_161);
    assert_eq!(
        engine.countersign(&again, at(NOW + 10)).err(),
        Some(EngineError::Replay)
    );
}

#[test]
fn binding_for_another_chain_names_it() {
    let engine = leg_a();
    let one = engine.binding_for(42_161).unwrap();
    assert_eq!(one.chain_id, 42_161);
    assert_eq!(one.signer, engine.signer());
    assert_eq!(
        engine.binding_for(1),
        Err(keelson_tee::Error::UnsupportedChain(1))
    );
}

#[test]
fn rejects_an_oversized_order_id_in_the_observation() {
    let issued = register();
    let mut o = observation((NOW + 10) * 1000);
    o.paypal.order_id = "O".repeat(257);
    let r = countersign_request(&issued, &CartFixture::demo(), request_id(1), Some(o));
    assert_eq!(
        leg_b().countersign(&r, at(NOW + 10)).err(),
        Some(EngineError::TooLarge("observation"))
    );
}

/// Countersigns over PayPal sandbox bodies recorded by `tests/paypal_sandbox.rs`.
#[cfg(feature = "tdx")]
mod holds {
    use super::*;
    use keelson_tee::UserRecords;
    use keelson_tee::wire::MandateIssued;

    const MID: &str = "01JBXG3K5N7Q9R2T4V6W8Y0Z1A";
    /// The request id the recorded per-purchase hold was created for.
    const PURCHASE: u128 = 40;
    const ALLOW: &str = "1";
    const DENY: &str = "2";

    fn hold_order(records: &Records) -> Option<Vec<u8>> {
        records.get(&format!("hold-order\0{MID}"))
    }

    fn setup() -> (Engine, MandateIssued, Arc<Records>) {
        let records = Arc::new(Records::default());
        let payee = paypal_vector("mandate-hold").payee_merchant_id;
        let (leg_a, issued) = leg_a_paying(&[&payee], records.clone());
        (leg_a, issued, records)
    }

    #[test]
    fn a_mandate_hold_is_bound_to_its_order() {
        let (leg_a, issued, records) = setup();
        let fresh = paypal_vector("mandate-hold");
        assert_eq!(fresh.order_id, "6XX99734C4618040C");
        let (a, b) = countersign_both(
            &leg_a,
            &issued,
            &CartFixture::thirty(),
            fresh,
            request_id(1),
        );
        for c in [&a, &b] {
            assert_eq!(c.countersign.decision, ALLOW, "{:?}", errors(c));
        }
        assert_eq!(a.digest.0, b.digest.0);
        assert_eq!(b.observation.paypal.order_id, "6XX99734C4618040C");
        assert!(hold_order(&records).is_some());

        // The same order after a capture is still the mandate's hold.
        let captured = paypal_vector("mandate-hold-captured");
        assert_eq!(captured.captured_minor, 3_000);
        assert_eq!(captured.order_captured_minor, 3_000);
        let (a, _) = countersign_both(
            &leg_a,
            &issued,
            &CartFixture::thirty(),
            captured,
            request_id(2),
        );
        assert_eq!(a.countersign.decision, ALLOW, "{:?}", errors(&a));

        let other = paypal_vector("mandate-hold-other-order");
        assert_ne!(other.order_id, "6XX99734C4618040C");
        let (a, _) = countersign_both(
            &leg_a,
            &issued,
            &CartFixture::thirty(),
            other,
            request_id(3),
        );
        assert_eq!(a.countersign.decision, DENY);
        assert_eq!(errors(&a), ["paypal.hold_mismatch"]);
    }

    #[test]
    #[ignore = "PayPal reauthorizes from day 4 of an authorization; needs the recorded mandate-hold-reauthorized vector"]
    fn a_reauthorization_of_the_bound_order_is_the_same_hold() {
        let (leg_a, issued, _) = setup();
        let f = CartFixture::thirty();
        let original = paypal_vector("mandate-hold");
        let reauthorized = paypal_vector("mandate-hold-reauthorized");
        assert_ne!(reauthorized.authorization_id, original.authorization_id);
        assert_eq!(reauthorized.order_id, original.order_id);
        // The parent's captures stay spent after the reauthorization.
        assert!(reauthorized.order_captured_minor > reauthorized.captured_minor);
        let (a, _) = countersign_both(&leg_a, &issued, &f, original, request_id(1));
        assert_eq!(a.countersign.decision, ALLOW, "{:?}", errors(&a));
        let (a, b) = countersign_both(&leg_a, &issued, &f, reauthorized, request_id(2));
        for c in [&a, &b] {
            assert_eq!(c.countersign.decision, ALLOW, "{:?}", errors(c));
        }
    }

    #[test]
    fn a_purchase_hold_backs_only_its_own_request() {
        let (leg_a, issued, records) = setup();
        let read = paypal_vector("purchase-hold");
        let f = CartFixture::sixty();
        let (a, b) = countersign_both(&leg_a, &issued, &f, read.clone(), request_id(PURCHASE));
        for c in [&a, &b] {
            assert_eq!(c.countersign.decision, ALLOW, "{:?}", errors(c));
        }
        assert_eq!(hold_order(&records), None);

        let (a, b) = countersign_both(&leg_a, &issued, &f, read, request_id(PURCHASE + 1));
        for c in [&a, &b] {
            assert_eq!(c.countersign.decision, DENY);
            assert_eq!(errors(c), ["paypal.mandate"]);
        }
    }

    #[test]
    fn a_purchase_hold_does_not_bind_the_mandate() {
        let (leg_a, issued, records) = setup();
        let f = CartFixture::sixty();
        let purchase = paypal_vector("purchase-hold");
        let (a, _) = countersign_both(&leg_a, &issued, &f, purchase, request_id(PURCHASE));
        assert_eq!(a.countersign.decision, ALLOW, "{:?}", errors(&a));
        let f = CartFixture::thirty();
        let (a, _) = countersign_both(
            &leg_a,
            &issued,
            &f,
            paypal_vector("mandate-hold"),
            request_id(1),
        );
        assert_eq!(a.countersign.decision, ALLOW, "{:?}", errors(&a));
        assert!(hold_order(&records).is_some());
    }

    #[test]
    fn a_captured_purchase_stops_counting_its_reservation() {
        let (leg_a, issued, _) = setup();
        let f = CartFixture::thirty();
        for n in [1, 2] {
            let (a, _) = countersign_both(
                &leg_a,
                &issued,
                &f,
                paypal_vector("mandate-hold"),
                request_id(n),
            );
            assert_eq!(a.countersign.decision, ALLOW, "{:?}", errors(&a));
        }
        // The first purchase is captured: its $30 is spent once, not also reserved.
        let first = request_id(1).to_string();
        let captured = paypal_vector_with("mandate-hold-captured", |v| {
            let capture = &mut v["order"]["purchase_units"][0]["payments"]["captures"][0];
            let invoice = capture["invoice_id"].as_str().unwrap().replace(MID, &first);
            capture["invoice_id"] = json!(invoice);
        });
        let (a, b) = countersign_both(&leg_a, &issued, &f, captured.clone(), request_id(3));
        for c in [&a, &b] {
            assert_eq!(c.countersign.decision, ALLOW, "{:?}", errors(c));
        }
        assert_eq!(a.observation.budget_left_minor, 4_000);
        // Request 2 is still only reserved, and request 3 now is too.
        let (a, _) = countersign_both(&leg_a, &issued, &f, captured, request_id(4));
        assert_eq!(a.observation.budget_left_minor, 1_000);
        assert_eq!(a.countersign.decision, DENY);
    }

    #[test]
    fn only_a_sandbox_hold_of_this_mandate_or_request_is_accepted() {
        let rid = request_id(PURCHASE).to_string();
        let digest = "SC4lPIQQS_7hUI1WoHbFiKBE6nmxEfU5sBAD1IV3YDI";
        for custom_id in [
            format!("ks1.pm.{MID}.{digest}"),
            format!("ks1.pa.{rid}.{digest}"),
            format!("ks1.sa.{MID}.{digest}"),
            format!("ks1.sm.{rid}.{digest}"),
            format!("ks1.sx.{MID}.{digest}"),
            format!("ks1.s.{MID}.{digest}"),
            format!("ks1.sa.{rid}.{}", &digest[1..]),
        ] {
            let (leg_a, issued, records) = setup();
            let mut read = paypal_vector("purchase-hold");
            read.custom_id = custom_id.clone();
            let f = CartFixture::sixty();
            let (a, b) = countersign_both(&leg_a, &issued, &f, read, request_id(PURCHASE));
            for c in [&a, &b] {
                assert_eq!(errors(c), ["paypal.mandate"], "{custom_id}");
            }
            assert_eq!(hold_order(&records), None);
        }
    }
}
