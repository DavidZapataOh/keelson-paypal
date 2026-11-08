#![allow(dead_code)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use alloy_primitives::{Address, Signature};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use keelson_canon::{Cart, PayPalUnit};
use keelson_core::{AcirField, Dst, hash_object};
use keelson_mandate::{
    CLOSED_MANDATE_AUD, Fr, Jwk, decode_mandate, h_sd, mandate_challenge, mandate_commitment,
};
use keelson_tee::wire::{
    Assertion, CountersignRequest, Countersigned, Hex, MandateIssued, Observation,
    PayPalObservation, RegisterMandate,
};
use keelson_tee::{CapturedSource, Engine, EngineConfig, EngineError, Root, TeeKind, UserRecords};
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature as P256Signature, SigningKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use ulid::Ulid;

/// Clock of the test runs: one minute after the demo mandate's `iat`.
pub const NOW: i64 = 1_793_750_460;
pub const ORIGIN: &str = "https://keelson.finance";
pub const BIT_AMOUNT: u32 = 1 << 3;
pub const BIT_BUDGET: u32 = 1 << 4;

pub fn issued() -> Value {
    serde_json::from_str(include_str!(
        "../../../../packages/mandate/test/vectors/issued.json"
    ))
    .unwrap()
}

pub fn hex_bytes(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn b64u(bytes: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The deterministic bytes the TypeScript vector script derives from a label.
pub fn seed(label: &str) -> [u8; 32] {
    Sha256::digest(format!("keelson/vectors/{label}")).into()
}

pub fn root() -> Root {
    Root::new(
        &hex_bytes(issued()["root"].as_str().unwrap())
            .try_into()
            .unwrap(),
    )
}

pub fn sub() -> String {
    issued()["users"][0]["sub"].as_str().unwrap().into()
}

pub fn agent_key() -> SigningKey {
    SigningKey::from_slice(&seed("key/agent")).unwrap()
}

pub fn jwk_of(key: &SigningKey) -> Jwk {
    Jwk::from_verifying_key(key.verifying_key())
}

pub fn at(seconds: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(seconds).unwrap()
}

pub fn config(issuer: Option<Jwk>) -> EngineConfig {
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
pub struct Captured {
    pub mandate_hash: [u8; 32],
    pub minor: i64,
}

impl CapturedSource for Captured {
    fn captured_minor(&self, mandate_hash: &[u8; 32]) -> Option<i64> {
        (*mandate_hash == self.mandate_hash).then_some(self.minor)
    }
}

/// Sealed user records kept in memory.
#[derive(Default)]
pub struct Records(Mutex<BTreeMap<String, Vec<u8>>>);

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

pub fn demo_mandate_hash() -> [u8; 32] {
    expected_mandate_hash(&register_request())
}

/// Leg A with nothing captured on the demo mandate, booted at `boot`.
pub fn leg_a_at(boot: i64, captured: i64) -> Engine {
    Engine::booted_at(config(None), Some(root()), at(boot))
        .with_captured(Arc::new(Captured {
            mandate_hash: demo_mandate_hash(),
            minor: captured,
        }))
        .with_user_records(Arc::new(Records::default()))
}

/// Leg A: holds the KMS root; booted long enough ago that its budget ledger is live.
pub fn leg_a() -> Engine {
    leg_a_at(NOW - 1_000, 0)
}

/// Leg B: no root, only the issuer public key.
pub fn leg_b() -> Engine {
    let issuer = jwk_of(&root().issuer_key());
    Engine::booted_at(config(Some(issuer)), None, at(NOW - 1_000))
}

pub fn register_request() -> RegisterMandate {
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

pub fn register() -> MandateIssued {
    leg_a()
        .register_mandate(&register_request(), at(NOW))
        .unwrap()
}

/// `M` computed from the request, independently of the engine.
pub fn expected_mandate_hash(r: &RegisterMandate) -> [u8; 32] {
    let cm = r.payload_sd["zk"]["commitment"].as_str().unwrap();
    let cm = Fr::from_be_bytes_reduce(&hex_bytes(cm));
    mandate_challenge(&h_sd(&r.payload_sd).unwrap(), &cm)
}

/// The passkey assertion a browser returns over `challenge` (WebAuthn section 7.2).
pub fn assertion(passkey: &SigningKey, challenge: &[u8; 32]) -> Assertion {
    assertion_on(ORIGIN, passkey, challenge)
}

/// [`assertion`] made on `origin`.
pub fn assertion_on(origin: &str, passkey: &SigningKey, challenge: &[u8; 32]) -> Assertion {
    let mut authenticator_data = Sha256::digest("keelson.finance").to_vec();
    authenticator_data.extend_from_slice(&[0x05, 0, 0, 0, 1]);
    let client_data_json = json!({
        "type": "webauthn.get",
        "challenge": b64u(challenge),
        "origin": origin,
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
pub fn mandate_for(sub: &str, passkey: &SigningKey) -> RegisterMandate {
    mandate_with(sub, passkey, |_| {})
}

/// [`mandate_for`] with `edit` applied to the mandate before it is committed to and confirmed.
pub fn mandate_with(
    sub: &str,
    passkey: &SigningKey,
    edit: impl FnOnce(&mut Value),
) -> RegisterMandate {
    mandate_on(ORIGIN, sub, passkey, edit)
}

/// [`mandate_with`] confirmed on `origin`.
pub fn mandate_on(
    origin: &str,
    sub: &str,
    passkey: &SigningKey,
    edit: impl FnOnce(&mut Value),
) -> RegisterMandate {
    let base = register_request();
    let mut m = decode_mandate(&base.payload_sd, &base.disclosures).unwrap();
    edit(&mut m);
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
        assertion: assertion_on(origin, passkey, &challenge),
        salt: base.salt,
        user_credential: None,
    }
}

pub fn other_passkey() -> SigningKey {
    SigningKey::from_slice(&seed("key/other")).unwrap()
}

pub struct CartFixture {
    pub raw: Value,
}

impl CartFixture {
    pub fn load(json: &str) -> Self {
        Self {
            raw: serde_json::from_str(json).unwrap(),
        }
    }

    pub fn demo() -> Self {
        Self::load(include_str!(
            "../../../canon/tests/fixtures/demo-shoes.json"
        ))
    }

    pub fn bundle() -> Self {
        Self::load(include_str!(
            "../../../canon/tests/fixtures/bundle-340.json"
        ))
    }

    pub fn breakdown_mismatch() -> Self {
        Self::load(include_str!(
            "../../../canon/tests/fixtures/breakdown-mismatch.json"
        ))
    }

    /// The demo shoes at $60.
    pub fn sixty() -> Self {
        let mut f = Self::demo();
        f.raw["cart"]["lines"][0]["unit_minor"] = json!(6000);
        f.raw["unit"]["amount"]["value"] = json!("60.00");
        f.raw["unit"]["amount"]["breakdown"]["item_total"]["value"] = json!("60.00");
        f
    }

    /// The demo shoes at $30.
    pub fn thirty() -> Self {
        let mut f = Self::demo();
        f.raw["cart"]["lines"][0]["unit_minor"] = json!(3000);
        f.raw["unit"]["amount"]["value"] = json!("30.00");
        f.raw["unit"]["amount"]["breakdown"]["item_total"]["value"] = json!("30.00");
        f
    }

    pub fn cart(&self) -> Cart {
        serde_json::from_value(self.raw["cart"].clone()).unwrap()
    }

    pub fn unit(&self) -> PayPalUnit {
        serde_json::from_value(self.raw["unit"].clone()).unwrap()
    }

    /// `H("keelson/cart/v1", cart)` over the fixture JSON.
    pub fn hash(&self) -> [u8; 32] {
        hash_object(Dst::Cart, &self.raw["cart"]).unwrap()
    }
}

/// Closes an open mandate with the agent's KB-JWT (RFC 9901 section 4.3).
pub fn close(open: &str, nonce: &str, cart_hash: &[u8; 32], iat: i64) -> String {
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

pub fn request_id(n: u128) -> Ulid {
    request_id_at(n, NOW * 1000)
}

/// A request id whose ULID time is `ms`.
pub fn request_id_at(n: u128, ms: i64) -> Ulid {
    Ulid::from_parts(ms as u64, n)
}

/// Countersigns `f` under `id` with the agent's key binding issued at `clock`.
pub fn countersign_at(
    engine: &Engine,
    issued: &MandateIssued,
    f: &CartFixture,
    id: Ulid,
    clock: i64,
) -> Result<Countersigned, EngineError> {
    let mut r = countersign_request(issued, f, id, None);
    r.closed_mandate = close(&issued.open_mandate, &id.to_string(), &f.hash(), clock);
    engine.countersign(&r, at(clock))
}

pub fn countersign_request(
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
        authorization_id: None,
        observation,
        chain_id: None,
    }
}

pub fn observation(now_ms: i64) -> Observation {
    Observation {
        now_ms,
        budget_left_minor: 10_000,
        user_key: jwk_of(&root().user_key(&sub())),
        paypal: PayPalObservation::default(),
    }
}

pub fn trace(c: &Countersigned) -> Value {
    serde_json::from_slice(&c.trace_jcs.0).unwrap()
}

pub fn mask(c: &Countersigned) -> u32 {
    c.countersign.failed_fields_mask.parse().unwrap()
}

pub fn recover(c: &Countersigned) -> Address {
    Signature::from_raw(&c.signature.0)
        .unwrap()
        .recover_address_from_prehash(&c.digest.0.into())
        .unwrap()
}

/// Leg A keeping its user records in `records`, with the demo mandate registered to pay
/// `payees`.
pub fn leg_a_paying(payees: &[&str], records: Arc<Records>) -> (Engine, MandateIssued) {
    let leg_a = Engine::booted_at(config(None), Some(root()), at(NOW - 1_000))
        .with_captured(Arc::new(Captured {
            mandate_hash: demo_mandate_hash(),
            minor: 0,
        }))
        .with_user_records(records);
    let allowed: Vec<Value> = payees
        .iter()
        .map(|p| json!({ "paypal_merchant_id": p }))
        .collect();
    let register = mandate_with(&sub(), &other_passkey(), |m| {
        let payees = m["payment"]["constraints"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|c| c["type"] == "payment.allowed_payees")
            .unwrap();
        payees["allowed"] = json!(allowed);
    });
    let issued = leg_a.register_mandate(&register, at(NOW)).unwrap();
    (leg_a, issued)
}

/// Countersigns `f` under `id` on `leg_a` over `read`, and on leg B over leg A's observation.
pub fn countersign_both(
    leg_a: &Engine,
    issued: &MandateIssued,
    f: &CartFixture,
    read: PayPalObservation,
    id: Ulid,
) -> (Countersigned, Countersigned) {
    let r = countersign_request(issued, f, id, None);
    let a = leg_a
        .countersign_with(&r, at(NOW + 10), Some(read))
        .unwrap();
    let r = countersign_request(issued, f, id, Some(a.observation.clone()));
    let b = leg_b().countersign(&r, at(NOW + 10)).unwrap();
    (a, b)
}

/// The deny reasons in the countersign's trace.
pub fn errors(c: &Countersigned) -> Vec<String> {
    trace(c)["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e.as_str().unwrap().to_owned())
        .collect()
}

/// Leg A's observation of the PayPal sandbox bodies recorded in `tests/vectors/paypal/<name>.json`.
#[cfg(feature = "tdx")]
pub fn paypal_vector(name: &str) -> PayPalObservation {
    let path = format!(
        "{}/tests/vectors/paypal/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    keelson_tee::paypal::parse(
        v["authorization_id"].as_str().unwrap(),
        serde_json::to_vec(&v["authorization"]).unwrap(),
        serde_json::to_vec(&v["order"]).unwrap(),
        v["read_at_ms"].as_i64().unwrap(),
    )
    .unwrap()
}
