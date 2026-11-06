use std::collections::BTreeMap;
use std::sync::Arc;
use std::thread;

use alloy_primitives::{Address, Signature};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use keelson_canon::{Cart, PayPalUnit};
use keelson_core::{AcirField, Dst, hash_object};
use keelson_mandate::{
    CLOSED_MANDATE_AUD, Fr, Jwk, OPEN_MANDATE_TYP, OpenMandateVerifyOptions, USER_CREDENTIAL_TYP,
    h_sd, mandate_challenge, verify_credential,
};
use keelson_tee::wire::{
    Assertion, Base64, CountersignRequest, Countersigned, Expected, Hex, MandateIssued,
    Observation, PayPalObservation, RegisterMandate,
};
use keelson_tee::{
    BIT_CANON, Engine, EngineConfig, EngineError, MANDATE_SALT_PURPOSE, Root, SealAad, TeeKind,
};
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature as P256Signature, SigningKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use ulid::Ulid;

/// Clock of the test runs: one minute after the demo mandate's `iat`.
const NOW: i64 = 1_793_750_460;
const ORIGIN: &str = "https://keelson.finance";
const BIT_AMOUNT: u32 = 1 << 3;
const BIT_BUDGET: u32 = 1 << 4;

fn issued() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/mandate/test/vectors/issued.json"
    ))
    .unwrap()
}

fn hex_bytes(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn b64u(bytes: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The deterministic bytes the TypeScript vector script derives from a label.
fn seed(label: &str) -> [u8; 32] {
    Sha256::digest(format!("keelson/vectors/{label}")).into()
}

fn root() -> Root {
    Root::new(
        &hex_bytes(issued()["root"].as_str().unwrap())
            .try_into()
            .unwrap(),
    )
}

fn sub() -> String {
    issued()["users"][0]["sub"].as_str().unwrap().into()
}

fn agent_key() -> SigningKey {
    SigningKey::from_slice(&seed("key/agent")).unwrap()
}

fn jwk_of(key: &SigningKey) -> Jwk {
    Jwk::from_verifying_key(key.verifying_key())
}

fn at(seconds: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(seconds).unwrap()
}

fn config(issuer: Option<Jwk>) -> EngineConfig {
    EngineConfig {
        chain_id: 421_614,
        bond_vault: Address::ZERO,
        verifying_contract: Address::ZERO,
        oci_digest: format!("sha256:{}", "ab".repeat(32)),
        canonicalizer: "keelson-canon/0.0.0".into(),
        tee_kind: TeeKind::Tdx,
        issuer,
        origin: ORIGIN.into(),
    }
}

/// Leg A: holds the KMS root; booted long enough ago that its budget ledger is live.
fn leg_a() -> Engine {
    Engine::booted_at(config(None), Some(root()), at(NOW - 1_000))
}

/// Leg B: no root, only the issuer public key.
fn leg_b() -> Engine {
    let issuer = jwk_of(&root().issuer_key());
    Engine::booted_at(config(Some(issuer)), None, at(NOW - 1_000))
}

fn register_request() -> RegisterMandate {
    let params = &issued()["openMandate"]["params"];
    let auth = &params["userAuth"];
    let s = |v: &Value| v.as_str().unwrap().to_owned();
    RegisterMandate {
        sub: sub(),
        payload_sd: params["payloadSd"].clone(),
        disclosures: params["disclosures"]
            .as_array()
            .unwrap()
            .iter()
            .map(s)
            .collect(),
        assertion: Assertion {
            authenticator_data: s(&auth["authenticatorData"]),
            client_data_json: s(&auth["clientDataJSON"]),
            signature: s(&auth["signature"]),
        },
        expected: Expected {
            origin: ORIGIN.into(),
            rp_id: "keelson.finance".into(),
        },
        salt: seed("salt/l2/commitment")[..16].try_into().unwrap(),
        user_credential: None,
    }
}

fn register() -> MandateIssued {
    leg_a()
        .register_mandate(&register_request(), at(NOW))
        .unwrap()
}

/// `M` computed from the request, independently of the engine.
fn expected_mandate_hash(r: &RegisterMandate) -> [u8; 32] {
    let cm = r.payload_sd["zk"]["commitment"].as_str().unwrap();
    let cm = Fr::from_be_bytes_reduce(&hex_bytes(cm));
    mandate_challenge(&h_sd(&r.payload_sd).unwrap(), &cm)
}

struct CartFixture {
    raw: Value,
}

impl CartFixture {
    fn load(json: &str) -> Self {
        Self {
            raw: serde_json::from_str(json).unwrap(),
        }
    }

    fn demo() -> Self {
        Self::load(include_str!("../../canon/tests/fixtures/demo-shoes.json"))
    }

    fn bundle() -> Self {
        Self::load(include_str!("../../canon/tests/fixtures/bundle-340.json"))
    }

    fn breakdown_mismatch() -> Self {
        Self::load(include_str!(
            "../../canon/tests/fixtures/breakdown-mismatch.json"
        ))
    }

    /// The demo shoes at $60.
    fn sixty() -> Self {
        let mut f = Self::demo();
        f.raw["cart"]["lines"][0]["unit_minor"] = json!(6000);
        f.raw["unit"]["amount"]["value"] = json!("60.00");
        f.raw["unit"]["amount"]["breakdown"]["item_total"]["value"] = json!("60.00");
        f
    }

    fn cart(&self) -> Cart {
        serde_json::from_value(self.raw["cart"].clone()).unwrap()
    }

    fn unit(&self) -> PayPalUnit {
        serde_json::from_value(self.raw["unit"].clone()).unwrap()
    }

    /// `H("keelson/cart/v1", cart)` over the fixture JSON.
    fn hash(&self) -> [u8; 32] {
        hash_object(Dst::Cart, &self.raw["cart"]).unwrap()
    }
}

/// Closes an open mandate with the agent's KB-JWT (RFC 9901 section 4.3).
fn close(open: &str, nonce: &str, cart_hash: &[u8; 32], iat: i64) -> String {
    let final_kb_sd_jwt = open.split_once("~~").unwrap().1;
    let header = json!({ "typ": "kb+jwt", "alg": "ES256" });
    let payload = json!({
        "iat": iat,
        "aud": CLOSED_MANDATE_AUD,
        "nonce": nonce,
        "cart_hash": format!("sha256:{}", hex(cart_hash)),
        "sd_hash": b64u(Sha256::digest(final_kb_sd_jwt)),
    });
    let input = format!("{}.{}", b64u(header.to_string()), b64u(payload.to_string()));
    let signature: P256Signature = agent_key().sign(input.as_bytes());
    format!("{open}{input}.{}", b64u(signature.to_bytes()))
}

fn request_id(n: u128) -> Ulid {
    Ulid::from_parts(NOW as u64 * 1000, n)
}

fn countersign_request(
    issued: &MandateIssued,
    f: &CartFixture,
    id: Ulid,
    observation: Option<Observation>,
) -> CountersignRequest {
    CountersignRequest {
        request_id: id,
        closed_mandate: close(&issued.open_mandate, &id.to_string(), &f.hash(), NOW),
        sub: sub(),
        cart: f.cart(),
        unit: f.unit(),
        evidence: BTreeMap::new(),
        evidence_root: Hex([0x55; 32]),
        observation,
    }
}

fn observation(now_ms: i64) -> Observation {
    Observation {
        now_ms,
        budget_left_minor: 10_000,
        user_key: jwk_of(&root().user_key(&sub())),
        paypal: PayPalObservation::default(),
    }
}

fn trace(c: &Countersigned) -> Value {
    serde_json::from_slice(&c.trace_jcs.0).unwrap()
}

fn mask(c: &Countersigned) -> u32 {
    c.countersign.failed_fields_mask.parse().unwrap()
}

fn recover(c: &Countersigned) -> Address {
    Signature::from_raw(&c.signature.0)
        .unwrap()
        .recover_address_from_prehash(&c.digest.0.into())
        .unwrap()
}

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

    let other = Engine::booted_at(config(None), Some(Root::new(&[7; 32])), at(NOW));
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

#[test]
fn refuses_an_observation_off_the_clock() {
    let issued = register();
    let f = CartFixture::demo();
    let clock = NOW + 10;
    for (skew, ok) in [
        (2_000, true),
        (-2_000, true),
        (2_001, false),
        (-2_001, false),
    ] {
        let r = countersign_request(
            &issued,
            &f,
            request_id(8),
            Some(observation(clock * 1000 + skew)),
        );
        let result = leg_a().countersign(&r, at(clock));
        match ok {
            true => assert_eq!(result.unwrap().countersign.decision, "1", "{skew}"),
            false => assert_eq!(result.unwrap_err(), EngineError::Clock, "{skew}"),
        }
    }
    assert_eq!(EngineError::Clock.code(), "clock_skew");
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

/// Two legs over the same request and clock agree on everything but the signature.
#[test]
fn two_legs_sign_the_same_digest() {
    let issued = register();
    let (a, b) = (leg_a(), leg_b());
    let clock = NOW + 10;
    let r = countersign_request(
        &issued,
        &CartFixture::demo(),
        request_id(11),
        Some(observation(clock * 1000)),
    );
    let first = a.countersign(&r, at(clock)).unwrap();
    assert_eq!(first.countersign.decision, "1");
    for _ in 0..1_000 {
        let (x, y) = (
            a.countersign(&r, at(clock)).unwrap(),
            b.countersign(&r, at(clock)).unwrap(),
        );
        for out in [&x, &y] {
            assert_eq!(out.digest.0, first.digest.0);
            assert_eq!(out.trace_jcs.0, first.trace_jcs.0);
        }
        assert_ne!(x.signature.0, y.signature.0);
        assert_eq!(recover(&x), a.signer());
        assert_eq!(recover(&y), b.signer());
        assert_eq!(x.tee, TeeKind::Tdx);
    }
    assert_ne!(a.signer(), b.signer());
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
    let engine = Engine::booted_at(config(None), Some(root()), at(NOW));
    let at_clock = |n: u128, clock: i64| {
        let id = request_id(n);
        let mut r = countersign_request(&issued, &f, id, None);
        r.closed_mandate = close(&issued.open_mandate, &id.to_string(), &f.hash(), clock);
        engine.countersign(&r, at(clock)).unwrap()
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
    let out = leg_a().countersign(&back, at(NOW + 10)).unwrap();
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
