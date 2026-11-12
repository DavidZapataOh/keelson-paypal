//! Bridging the two real v1 fixture Alibis into SCITT statements.

mod common;

use std::sync::Arc;

use alloy_primitives::Address;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use common::*;
use keelson_tee::logsign::{LogKey, LogSigner, SignRequest};
use keelson_tee::wire::{Base64, BridgeRequest, CountersignJson};
use keelson_tee::{Engine, EngineError, Root};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const ORIGIN: &str = "log.keelson.finance/alibi/2026-1";
const FIXTURES: [&str; 2] = [
    include_str!("../../../packages/alibi/test/fixtures/01M6ZWZJHWRRHQEYNJAT7NMSV8.alibi"),
    include_str!("../../../packages/alibi/test/fixtures/01M6ZX07MFWDDDW4199FDJHWEG.alibi"),
];

fn leaf_hash(leaf: &[u8]) -> [u8; 32] {
    Sha256::new()
        .chain_update([0])
        .chain_update(leaf)
        .finalize()
        .into()
}

fn node(l: &[u8; 32], r: &[u8; 32]) -> [u8; 32] {
    Sha256::new()
        .chain_update([1])
        .chain_update(l)
        .chain_update(r)
        .finalize()
        .into()
}

/// Leg A on the fixtures' chain and contract, holding a test log key for the sandbox origin.
fn leg(records: Arc<Records>) -> (Engine, LogSigner, Root) {
    let mut c = config(None);
    c.verifying_contract = "0xe16E8767EC1DA59Ef0D9Bc7851637E4D22352d96"
        .parse::<Address>()
        .unwrap();
    let key = || LogKey::new(ORIGIN, &Zeroizing::new([9; 32]), vec![]);
    let engine = Engine::booted_at(c, Some(root()), at(NOW - 1_000))
        .with_log_signer(Arc::new(LogSigner::new(vec![key()], records.clone())));
    (engine, LogSigner::new(vec![key()], records), root())
}

/// A tlog-proof of `leaf` at index 0 of a two-leaf tree whose checkpoint `signer` signed.
fn proof(signer: &LogSigner, root: &Root, leaf: &[u8]) -> String {
    let h0 = leaf_hash(leaf);
    let h1 = leaf_hash(b"neighbour");
    let tree = node(&h0, &h1);
    let body = format!("{ORIGIN}\n2\n{}\n", STANDARD.encode(tree));
    let signed = signer
        .sign(
            root,
            Some((0, [0; 32])),
            &SignRequest {
                checkpoint: body.clone(),
                from_size: None,
                consistency: vec![],
            },
        )
        .unwrap();
    let sig = STANDARD.decode(&signed.signature).unwrap();
    let id = &STANDARD
        .decode(signed.vkey.rsplit('+').next().unwrap())
        .unwrap();
    let key = &id[1..];
    let mut name = Sha256::new();
    name.update(ORIGIN);
    name.update([b'\n', 1]);
    name.update(key);
    let mut line = name.finalize()[..4].to_vec();
    line.extend_from_slice(&sig);
    format!(
        "c2sp.org/tlog-proof@v1\nindex 0\n{}\n\n{body}\n\u{2014} {ORIGIN} {}\n",
        STANDARD.encode(h1),
        STANDARD.encode(line)
    )
}

fn request(fixture: &str, tlog_proof: String) -> BridgeRequest {
    let b: Value = serde_json::from_str(fixture).unwrap();
    BridgeRequest {
        leaf: Base64(STANDARD.decode(b["leaf"].as_str().unwrap()).unwrap()),
        tlog_proof,
        countersign: serde_json::from_value::<CountersignJson>(b["tee"]["countersign"].clone())
            .unwrap(),
        chain_id: Some(421_614),
    }
}

#[test]
fn bridges_both_fixtures() {
    for fixture in FIXTURES {
        let (engine, signer, root) = leg(Arc::new(Records::default()));
        let r = request(fixture, String::new());
        let r = BridgeRequest {
            tlog_proof: proof(&signer, &root, &r.leaf.0),
            ..r
        };
        let s = engine.bridge(&r).unwrap();
        let cose = coset::CoseSign1::from_tagged_slice(&s.statement.0).unwrap();
        assert_eq!(cose.protected.header.key_id, engine.signer().to_vec());
        let payload: ciborium::Value =
            ciborium::from_reader(cose.payload.as_deref().unwrap()).unwrap();
        let predecessor = payload
            .as_map()
            .unwrap()
            .iter()
            .find(|(k, _)| k.as_integer() == Some(23.into()))
            .map(|(_, v)| v.as_bytes().unwrap().clone())
            .unwrap();
        assert_eq!(predecessor, leaf_hash(&r.leaf.0).to_vec());
    }
}

#[test]
fn refuses_what_does_not_check_out() {
    let (engine, signer, root) = leg(Arc::new(Records::default()));
    let good = request(FIXTURES[0], String::new());
    let tlog_proof = proof(&signer, &root, &good.leaf.0);

    let mut changed = good.clone();
    changed.countersign.amount = "101".into();
    changed.tlog_proof = tlog_proof.clone();
    assert_eq!(
        engine.bridge(&changed).unwrap_err(),
        EngineError::BadRequest("bridge.digest")
    );

    // The fixture's own proof is signed by the log's earlier key, not this leg's.
    let b: Value = serde_json::from_str(FIXTURES[0]).unwrap();
    let mut foreign = good.clone();
    foreign.tlog_proof = b["tlog_proof"].as_str().unwrap().into();
    assert_eq!(
        engine.bridge(&foreign).unwrap_err(),
        EngineError::BadRequest("bridge.inclusion")
    );

    // A proof of another leaf.
    let other = request(FIXTURES[1], tlog_proof);
    assert_eq!(
        engine.bridge(&other).unwrap_err(),
        EngineError::BadRequest("bridge.inclusion")
    );
}

#[test]
fn leg_b_cannot_bridge() {
    assert_eq!(
        leg_b()
            .bridge(&request(FIXTURES[0], String::new()))
            .unwrap_err(),
        EngineError::BadRequest("bridge.leg")
    );
}

use coset::TaggedCborSerializable as _;

/// The bridge statement of `fixture` with a receipt from a checkpoint of this leg's log key: a
/// tree of the statement and one neighbour.
fn receipted_bridge(engine: &Engine, signer: &LogSigner, root: &Root, fixture: &str) -> Vec<u8> {
    use keelson_core::statement::{build_receipt, receipt_protected, with_receipts};
    let r = request(fixture, String::new());
    let r = BridgeRequest {
        tlog_proof: proof(signer, root, &r.leaf.0),
        ..r
    };
    let statement = engine.bridge(&r).unwrap().statement.0;
    let (h0, h1) = (leaf_hash(&statement), leaf_hash(b"neighbour"));
    let receipts = LogSigner::new(
        vec![LogKey::new(ORIGIN, &Zeroizing::new([9; 32]), vec![])],
        Arc::new(Records::default()),
    );
    let signed = receipts
        .sign(
            root,
            Some((0, [0; 32])),
            &SignRequest {
                checkpoint: format!("{ORIGIN}\n2\n{}\n", STANDARD.encode(node(&h0, &h1))),
                from_size: None,
                consistency: vec![],
            },
        )
        .unwrap();
    let key = receipts.keys()[0].receipt_public_key();
    let sig: [u8; 64] = STANDARD
        .decode(&signed.receipt_signature)
        .unwrap()
        .try_into()
        .unwrap();
    let receipt = build_receipt(&receipt_protected(&key, ORIGIN), sig, 2, 0, &[h1]);
    with_receipts(&statement, &[receipt]).unwrap()
}

#[test]
fn signs_an_export_of_a_bridged_alibi() {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use keelson_tee::wire::ExportRequest;
    let (engine, signer, root) = leg(Arc::new(Records::default()));
    let statement = receipted_bridge(&engine, &signer, &root, FIXTURES[0]);
    let b: Value = serde_json::from_str(FIXTURES[0]).unwrap();
    let c = &b["tee"]["countersign"];
    let lower = |k: &str| c[k].as_str().unwrap().to_lowercase();
    let facts = serde_json::json!({
        "agent_id": c["agentId"],
        "amount_minor": c["amount"],
        "cart_hash": lower("cartHash"),
        "currency": c["currency"],
        "decision": if c["decision"] == "1" { "allow" } else { "deny" },
        "issued_at": c["issuedAt"].as_str().unwrap().parse::<u64>().unwrap(),
        "mandate_hash": lower("mandateHash"),
        "merchant_id": lower("merchantId"),
        "request_id": b["alibi_id"],
    });
    let r = ExportRequest {
        typ: "JWT".into(),
        payload: serde_json::json!({
            "keelson": {
                "facts": facts,
                "profile": "keelson.export/1",
                "statement": URL_SAFE_NO_PAD.encode(&statement),
            },
        }),
        statement: Base64(statement),
    };
    let jws = engine.sign_export(&r).unwrap().jws;
    assert_eq!(jws.split('.').count(), 3);
}
