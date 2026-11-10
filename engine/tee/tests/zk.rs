//! C1 proofs with the pinned `bb` (`KEELSON_BB`, the `bb` of `@aztec/bb.js` 5.3.0, and
//! `CRS_PATH`, a directory holding `zk/bn254_g1.dat`): of the demo mandate, checked against the
//! vector `packages/mandate` writes, and of leg A's countersigns.

mod common;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use acir::{AcirField, FieldElement};
use common::*;
use keelson_mandate::{mandate_opening, merchant_leaf, merchant_membership};
use keelson_tee::wire::{Base64, Countersigned, ZkProof};
use keelson_tee::zk::{C1Proof, Prover, ProverError, Statement};
use keelson_tee::{C1Status, Engine};
use serde_json::Value;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read(path: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(repo().join(path)).unwrap()).unwrap()
}

fn shared() -> &'static Arc<Prover> {
    static PROVER: OnceLock<Arc<Prover>> = OnceLock::new();
    PROVER.get_or_init(|| {
        let bb = std::env::var("KEELSON_BB").expect("KEELSON_BB names the bb binary");
        Arc::new(Prover::spawn(bb.as_ref()).unwrap())
    })
}

fn prover() -> &'static Prover {
    shared()
}

fn field(v: &Value) -> FieldElement {
    FieldElement::try_from_str(v.as_str().unwrap()).unwrap()
}

fn field_hex(f: &FieldElement) -> String {
    format!("0x{}", f.to_hex())
}

struct Demo {
    statement: Statement,
    opening: keelson_mandate::MandateOpening,
    merchant: keelson_mandate::MembershipProof,
    vector: Value,
}

fn demo() -> Demo {
    let vector = read("packages/mandate/test/vectors/c1.json");
    let mandate = read("packages/mandate/test/fixtures/demo-mandate.json");
    let salt: [u8; 16] = std::array::from_fn(|i| i as u8 + 1);
    let opening = mandate_opening(&mandate, salt).unwrap();
    let merchant = merchant_membership(&opening.merchants, "mrc_runfast").unwrap();
    let i = &vector["inputs"];
    let int = |k: &str| i[k].as_str().unwrap().parse::<u64>().unwrap();
    let statement = Statement {
        c_m: opening.commitment(),
        amount: int("amount"),
        currency: int("currency") as u16,
        category: int("category") as u8,
        merchant_id: merchant_leaf("mrc_runfast").unwrap(),
        now: int("now"),
        cart_hash: field(&i["cart_hash"]),
        operator_id: opening.operator_id,
    };
    Demo {
        statement,
        opening,
        merchant,
        vector,
    }
}

#[test]
fn the_engine_opening_is_the_one_the_mandate_package_writes() {
    let d = demo();
    let i = &d.vector["inputs"];
    assert_eq!(field_hex(&d.statement.c_m), i["c_m"]);
    assert_eq!(field_hex(&d.statement.merchant_id), i["merchant_id"]);
    assert_eq!(field_hex(&d.opening.user_key_hash), i["user_key_hash"]);
    assert_eq!(field_hex(&d.opening.merchants.root()), i["merchant_root"]);
    assert_eq!(field_hex(&d.opening.nonce), i["nonce"]);
    assert_eq!(field_hex(&d.opening.salt), i["salt"]);
    assert_eq!(d.opening.max_amount.to_string(), i["max_amount"]);
    assert_eq!(d.opening.category_mask.to_string(), i["category_mask"]);
    assert_eq!(d.opening.expiry.to_string(), i["expiry"]);
    assert_eq!(d.opening.operator_id.to_string(), i["operator_id"]);
    let m = &i["merchant"];
    assert_eq!(field_hex(&d.merchant.leaf.next), m["next"]);
    assert_eq!(d.merchant.leaf.next_index.to_string(), m["next_index"]);
    assert_eq!(d.merchant.index.to_string(), m["index"]);
    let path: Vec<String> = d.merchant.path.iter().map(field_hex).collect();
    assert_eq!(serde_json::to_value(path).unwrap(), m["path"]);
}

#[test]
fn a_compliant_cart_proves_and_verifies() {
    let d = demo();
    let proof = prover()
        .prove(&d.statement, &d.opening, &d.merchant)
        .unwrap();
    assert!(prover().verify(&proof).unwrap());
    let expected: Vec<String> = [
        "c_m",
        "amount",
        "currency",
        "category",
        "merchant_id",
        "now",
        "cart_hash",
        "operator_id",
    ]
    .iter()
    .map(|k| {
        let v = &d.vector["inputs"][*k];
        let f = FieldElement::try_from_str(v.as_str().unwrap()).unwrap();
        field_hex(&f)
    })
    .collect();
    let got: Vec<String> = proof
        .public_inputs
        .iter()
        .map(|b| field_hex(&FieldElement::from_be_bytes_reduce(b)))
        .collect();
    assert_eq!(got, expected);
}

#[test]
fn the_recursive_proof_verifies_for_the_same_statement_only() {
    let d = demo();
    let mut proof = prover()
        .prove(&d.statement, &d.opening, &d.merchant)
        .unwrap();
    // `bb prove -t noir-recursive` with ZK: what `std::verify_proof_with_type` takes, 458 fields.
    assert_eq!(proof.recursive_proof.len(), 458 * 32);
    assert!(prover().verify_recursive(&proof).unwrap());
    proof.public_inputs[1][31] ^= 1;
    assert!(!prover().verify_recursive(&proof).unwrap_or(false));
}

#[test]
fn an_amount_over_the_maximum_does_not_prove() {
    let mut d = demo();
    d.statement.amount = d.opening.max_amount + 1;
    let err = prover()
        .prove(&d.statement, &d.opening, &d.merchant)
        .unwrap_err();
    assert!(matches!(err, ProverError::Unsatisfied(_)), "{err}");
}

#[test]
fn another_statement_does_not_verify() {
    let d = demo();
    let mut proof = prover()
        .prove(&d.statement, &d.opening, &d.merchant)
        .unwrap();
    proof.public_inputs[1][31] ^= 1;
    assert!(!prover().verify(&proof).unwrap_or(false));
}

/// The budget is 200 ms per proof, witness and `bb` included, for the EVM and recursive proofs.
#[test]
fn proving_is_within_budget() {
    let d = demo();
    prover()
        .prove(&d.statement, &d.opening, &d.merchant)
        .unwrap();
    let mut ms: Vec<f64> = (0..20)
        .map(|_| {
            let t = Instant::now();
            prover()
                .prove(&d.statement, &d.opening, &d.merchant)
                .unwrap();
            t.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    ms.sort_by(f64::total_cmp);
    println!("C1 prove: p50 {:.1} ms, max {:.1} ms", ms[10], ms[19]);
    assert!(ms[10] < 200.0, "p50 {:.1} ms", ms[10]);
}

const WAIT: Duration = Duration::from_secs(8);

/// What `GET /v1/c1/{request_id}` serves once the leg proved `out` after answering it.
fn proved(leg: &Engine, out: &Countersigned) -> C1Status {
    let id = request_id_of(out);
    leg.prove_c1(&id);
    leg.c1(&id, WAIT)
}

/// The request id the countersign was answered for, as the route takes it.
fn request_id_of(out: &Countersigned) -> String {
    ulid::Ulid::from_bytes(out.countersign.request_id.0[16..].try_into().unwrap()).to_string()
}

fn c1_of(status: C1Status) -> C1Proof {
    let C1Status::Ready(c1) = status else {
        panic!("leg A proved the ALLOW: {status:?}");
    };
    C1Proof {
        proof: c1.proof.0.clone(),
        public_inputs: c1.public_inputs.iter().map(|h| h.0).collect(),
        recursive_proof: c1.recursive_proof.as_ref().expect("a recursive proof").0.clone(),
    }
}

fn word(n: u64) -> [u8; 32] {
    let mut w = [0; 32];
    w[24..].copy_from_slice(&n.to_be_bytes());
    w
}

#[test]
fn leg_a_proves_the_allow_of_a_request_carrying_the_sealed_salt() {
    let issued = register();
    let f = CartFixture::demo();
    let mut r = countersign_request(&issued, &f, request_id(1), None);
    r.sealed_salt = Some(issued.sealed_salt.clone());
    let a = leg_a().with_prover(shared().clone());
    let out = a.countersign(&r, at(NOW + 10)).unwrap();
    let c = &out.countersign;
    assert_eq!(c.decision, "1");
    // Answered before any proof exists: the proof is made after, off the countersign's path.
    assert_eq!(
        a.c1(&request_id_of(&out), Duration::ZERO),
        C1Status::Pending
    );
    let proof = c1_of(proved(&a, &out));
    assert!(prover().verify(&proof).unwrap());
    let cart_hash = FieldElement::from_be_bytes_reduce(&c.cart_hash.0).to_be_bytes();
    let expected: Vec<[u8; 32]> = vec![
        c.mandate_commitment.0,
        word(c.amount.parse().unwrap()),
        word(c.currency.parse().unwrap()),
        word(c.category.parse().unwrap()),
        c.merchant_id.0,
        word(c.issued_at.parse().unwrap()),
        cart_hash.try_into().unwrap(),
        word(c.agent_id.parse().unwrap()),
    ];
    assert_eq!(proof.public_inputs, expected);
    // Proving again changes nothing; the same proof is served.
    assert_eq!(c1_of(proved(&a, &out)), proof);

    // Leg B cannot open the salt: it signs the same digest and proves nothing.
    r.observation = Some(out.observation.clone());
    let b = leg_b().with_prover(shared().clone());
    assert!(!b.proves_c1());
    let out_b = b.countersign(&r, at(NOW + 10)).unwrap();
    assert_eq!(out_b.digest, out.digest);
    assert_eq!(proved(&b, &out_b), C1Status::None);
}

#[test]
fn a_replayed_countersign_queues_no_second_proof() {
    let issued = register();
    let f = CartFixture::demo();
    let mut r = countersign_request(&issued, &f, request_id(5), None);
    r.sealed_salt = Some(issued.sealed_salt.clone());
    let a = leg_a().with_prover(shared().clone());
    let out = a.countersign(&r, at(NOW + 10)).unwrap();
    let first = c1_of(proved(&a, &out));
    let again = a.countersign(&r, at(NOW + 11)).unwrap();
    assert_eq!(again.digest, out.digest);
    assert_eq!(
        a.c1(&request_id_of(&out), Duration::ZERO),
        C1Status::Ready(zk(&first))
    );
}

#[test]
fn without_the_sealed_salt_leg_a_proves_nothing() {
    let issued = register();
    let f = CartFixture::demo();
    let r = countersign_request(&issued, &f, request_id(2), None);
    let a = leg_a().with_prover(shared().clone());
    let out = a.countersign(&r, at(NOW + 10)).unwrap();
    assert_eq!(out.countersign.decision, "1");
    assert_eq!(proved(&a, &out), C1Status::None);
}

#[test]
fn a_deny_carries_no_proof() {
    let issued = register();
    let f = CartFixture::bundle();
    let mut r = countersign_request(&issued, &f, request_id(3), None);
    r.sealed_salt = Some(issued.sealed_salt.clone());
    let a = leg_a().with_prover(shared().clone());
    let out = a.countersign(&r, at(NOW + 10)).unwrap();
    assert_eq!(out.countersign.decision, "2");
    assert_eq!(proved(&a, &out), C1Status::None);
}

#[test]
fn a_salt_that_does_not_open_leaves_the_allow_without_a_proof() {
    let issued = register();
    let f = CartFixture::demo();
    let mut r = countersign_request(&issued, &f, request_id(4), None);
    let mut sealed = issued.sealed_salt.0.clone();
    *sealed.last_mut().unwrap() ^= 1;
    r.sealed_salt = Some(Base64(sealed));
    let a = leg_a().with_prover(shared().clone());
    let out = a.countersign(&r, at(NOW + 10)).unwrap();
    assert_eq!(out.countersign.decision, "1");
    assert_eq!(proved(&a, &out), C1Status::None);
}

#[test]
fn an_unknown_request_has_no_proof() {
    let a = leg_a().with_prover(shared().clone());
    assert_eq!(
        a.c1(&request_id(9).to_string(), Duration::ZERO),
        C1Status::None
    );
}

fn zk(p: &C1Proof) -> ZkProof {
    ZkProof {
        proof: Base64(p.proof.clone()),
        public_inputs: p
            .public_inputs
            .iter()
            .map(|b| keelson_tee::wire::Hex(*b))
            .collect(),
        recursive_proof: Some(Base64(p.recursive_proof.clone())),
    }
}

#[cfg(unix)]
#[test]
fn a_bb_that_does_not_answer_is_abandoned_at_the_deadline() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = std::env::temp_dir().join(format!("keelson-zk-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let silent = dir.join("bb");
    std::fs::write(&silent, "#!/bin/sh\nexec sleep 60\n").unwrap();
    std::fs::set_permissions(&silent, std::fs::Permissions::from_mode(0o755)).unwrap();
    let prover = Prover::spawn(&silent).unwrap();
    let d = demo();
    let t = Instant::now();
    let err = prover
        .prove(&d.statement, &d.opening, &d.merchant)
        .unwrap_err();
    assert!(matches!(err, ProverError::Backend(_)), "{err}");
    assert!(t.elapsed().as_secs() < 10);
}

/// Over HTTP: the countersign is answered, then the prover thread proves it and the route
/// serves the proof.
#[tokio::test]
async fn leg_a_serves_the_proof_after_answering_over_http() {
    use axum::body::Body;
    use axum::http::{Request, StatusCode, header};
    use http_body_util::BodyExt;
    use keelson_tee::server::{AppState, router};
    use sha2::{Digest, Sha256};
    use tower::ServiceExt;

    let issued = register();
    let f = CartFixture::demo();
    let mut r = countersign_request(&issued, &f, request_id(6), None);
    r.sealed_salt = Some(issued.sealed_salt.clone());
    let state = AppState::new(
        leg_a().with_prover(shared().clone()),
        Sha256::digest("t").into(),
    )
    .with_clock(|| at(NOW + 10));
    let app = router(std::sync::Arc::new(state));
    let send = |req: Request<Body>| {
        let app = app.clone();
        async move {
            let res = app.oneshot(req).await.unwrap();
            let status = res.status();
            (status, res.into_body().collect().await.unwrap().to_bytes())
        }
    };
    let (status, body) = send(
        Request::post("/v1/countersign")
            .header(header::AUTHORIZATION, "Bearer t")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&r).unwrap()))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let out: Countersigned = serde_json::from_slice(&body).unwrap();
    let (status, body) = send(
        Request::get(format!("/v1/c1/{}", r.request_id))
            .header(header::AUTHORIZATION, "Bearer t")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let proof: ZkProof = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        proof.public_inputs[0].0,
        out.countersign.mandate_commitment.0
    );
    assert!(prover().verify(&c1_of(C1Status::Ready(proof))).unwrap());
}
