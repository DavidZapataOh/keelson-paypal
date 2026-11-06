use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::thread;

use alloy_primitives::{Address, Signature};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use keelson_canon::{Cart, PayPalUnit};
use keelson_core::{AcirField, Dst, hash_object};
use keelson_mandate::{
    CLOSED_MANDATE_AUD, Fr, Jwk, OPEN_MANDATE_TYP, OpenMandateVerifyOptions, USER_CREDENTIAL_TYP,
    decode_mandate, h_sd, mandate_challenge, mandate_commitment, verify_credential,
};
use keelson_tee::wire::{
    Assertion, Base64, CountersignRequest, Countersigned, Hex, MandateIssued, Observation,
    PayPalObservation, RegisterMandate,
};
use keelson_tee::{
    BIT_CANON, CapturedSource, Engine, EngineConfig, EngineError, MANDATE_SALT_PURPOSE, Root,
    SealAad, TeeKind, UserRecords,
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

/// What the engine's own PayPal read reports as captured, for one mandate.
struct Captured {
    mandate_hash: [u8; 32],
    minor: i64,
}

impl CapturedSource for Captured {
    fn captured_minor(&self, mandate_hash: &[u8; 32]) -> Option<i64> {
        (*mandate_hash == self.mandate_hash).then_some(self.minor)
    }
}

/// Sealed user records kept in memory.
#[derive(Default)]
struct Records(Mutex<BTreeMap<String, Vec<u8>>>);

impl UserRecords for Records {
    fn get(&self, sub: &str) -> Option<Vec<u8>> {
        self.0.lock().unwrap().get(sub).cloned()
    }

    fn insert_new(&self, sub: &str, record: Vec<u8>) -> bool {
        let mut records = self.0.lock().unwrap();
        if records.contains_key(sub) {
            return false;
        }
        records.insert(sub.to_owned(), record);
        true
    }
}

fn demo_mandate_hash() -> [u8; 32] {
    expected_mandate_hash(&register_request())
}

/// Leg A with nothing captured on the demo mandate, booted at `boot`.
fn leg_a_at(boot: i64, captured: i64) -> Engine {
    Engine::booted_at(config(None), Some(root()), at(boot))
        .with_captured(Arc::new(Captured {
            mandate_hash: demo_mandate_hash(),
            minor: captured,
        }))
        .with_user_records(Arc::new(Records::default()))
}

/// Leg A: holds the KMS root; booted long enough ago that its budget ledger is live.
fn leg_a() -> Engine {
    leg_a_at(NOW - 1_000, 0)
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

/// The passkey assertion a browser returns over `challenge` (WebAuthn section 7.2).
fn assertion(passkey: &SigningKey, challenge: &[u8; 32]) -> Assertion {
    let mut authenticator_data = Sha256::digest("keelson.finance").to_vec();
    authenticator_data.extend_from_slice(&[0x05, 0, 0, 0, 1]);
    let client_data_json = json!({
        "type": "webauthn.get",
        "challenge": b64u(challenge),
        "origin": ORIGIN,
        "crossOrigin": false,
    })
    .to_string();
    let signed = [&authenticator_data[..], &Sha256::digest(&client_data_json)].concat();
    let signature: P256Signature = passkey.sign(&signed);
    Assertion {
        authenticator_data: b64u(&authenticator_data),
        client_data_json: b64u(&client_data_json),
        signature: b64u(signature.to_der().as_bytes()),
    }
}

/// The demo mandate for `sub`, confirmed with `passkey`, with every claim disclosed in place.
fn mandate_for(sub: &str, passkey: &SigningKey) -> RegisterMandate {
    let base = register_request();
    let mut m = decode_mandate(&base.payload_sd, &base.disclosures).unwrap();
    let key = jwk_of(passkey);
    m["user"]["sub"] = json!(sub);
    m["user"]["cred"]["jwk"] = json!({ "kty": "EC", "crv": "P-256", "x": key.x, "y": key.y });
    let cm = mandate_commitment(&m, base.salt).unwrap();
    m["zk"]["commitment"] = json!(format!("0x{}", hex(&cm.to_be_bytes())));
    let mut payload_sd = m.clone();
    payload_sd["cnf"] = json!({ "jwk": m["agent"]["cnf"]["jwk"] });
    let challenge = mandate_challenge(&h_sd(&payload_sd).unwrap(), &cm);
    RegisterMandate {
        sub: sub.into(),
        payload_sd,
        disclosures: Vec::new(),
        assertion: assertion(passkey, &challenge),
        salt: base.salt,
        user_credential: None,
    }
}

fn other_passkey() -> SigningKey {
    SigningKey::from_slice(&seed("key/other")).unwrap()
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

    let no_records = Engine::booted_at(config(None), Some(root()), at(NOW));
    let err = no_records
        .register_mandate(&register_request(), at(NOW))
        .unwrap_err();
    assert_eq!(err, EngineError::NotReady);
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

/// The first registration binds a user to their passkey.
#[test]
fn a_user_stays_bound_to_their_first_passkey() {
    let records = Arc::new(Records::default());
    let engine =
        Engine::booted_at(config(None), Some(root()), at(NOW)).with_user_records(records.clone());
    engine
        .register_mandate(&register_request(), at(NOW))
        .unwrap();
    engine
        .register_mandate(&register_request(), at(NOW))
        .unwrap();

    let err = engine
        .register_mandate(&mandate_for(&sub(), &other_passkey()), at(NOW))
        .unwrap_err();
    assert_eq!(err, EngineError::Auth("sub_bound".into()));
    assert_eq!(err.code(), "auth.sub_bound");

    // A user credential this issuer gave `sub` for that passkey vouches for it.
    let elsewhere = Engine::booted_at(config(None), Some(root()), at(NOW))
        .with_user_records(Arc::new(Records::default()));
    let l1 = elsewhere
        .register_mandate(&mandate_for(&sub(), &other_passkey()), at(NOW))
        .unwrap()
        .user_credential;
    let mut vouched = mandate_for(&sub(), &other_passkey());
    vouched.user_credential = Some(l1);
    engine.register_mandate(&vouched, at(NOW)).unwrap();

    // Another user may register that passkey.
    engine
        .register_mandate(&mandate_for("kls_usr_other", &other_passkey()), at(NOW))
        .unwrap();

    // A record moved to another user's slot does not open there.
    let theirs = records.get("kls_usr_other").unwrap();
    let victim = "kls_usr_victim";
    assert!(records.insert_new(victim, theirs));
    let err = engine
        .register_mandate(&mandate_for(victim, &other_passkey()), at(NOW))
        .unwrap_err();
    assert_eq!(err.code(), "auth.sub_bound");
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

/// A request id's claim and its reservation expire together, with the countersign.
#[test]
fn a_request_id_and_its_reservation_expire_together() {
    let issued = register();
    let engine = leg_a();
    let id = request_id(70);
    let at_clock = |f: &CartFixture, id: Ulid, clock: i64| {
        let mut r = countersign_request(&issued, f, id, None);
        r.closed_mandate = close(&issued.open_mandate, &id.to_string(), &f.hash(), clock);
        engine.countersign(&r, at(clock))
    };
    let first = at_clock(&CartFixture::sixty(), id, NOW + 10).unwrap();
    assert_eq!(first.countersign.decision, "1");
    let expires: i64 = first.countersign.expires_at.parse().unwrap();

    // Until then the id is taken and the $60 stays reserved.
    let err = at_clock(&CartFixture::demo(), id, expires - 1).unwrap_err();
    assert_eq!(err, EngineError::Replay);
    let probe = at_clock(&CartFixture::demo(), request_id(71), expires - 1).unwrap();
    assert_eq!(probe.observation.budget_left_minor, 4_000);

    // Then both are gone: the id is free, and a new cart under it is charged in full.
    let again = at_clock(&CartFixture::demo(), id, expires).unwrap();
    assert_eq!(again.countersign.decision, "1");
    assert_eq!(again.observation.budget_left_minor, 10_000);
    let probe = at_clock(&CartFixture::sixty(), request_id(72), expires).unwrap();
    assert_eq!(probe.observation.budget_left_minor, 600);
}
