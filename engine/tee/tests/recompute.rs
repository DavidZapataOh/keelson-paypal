//! The countersign recomputed outside the engine from its stored inputs, as the SP1 program does
//! for a dispute, equals the one the legs sign.

mod common;

use std::path::Path;

use alloy_primitives::{Address, B256, U256, address};
use keelson_core::eip712::Countersign;
use keelson_mandate::h_sd;
use keelson_policy::{CountersignInput, recompute};
use keelson_tee::wire::{CountersignRequest, Countersigned};
use serde_json::{Value, json};

use common::*;

/// The demo agent registered in the ERC-8004 Identity registry on Arbitrum Sepolia.
const DEMO_AGENT_ID: &str = "351";
/// The `VerdictVerifier` whose domain the legs sign under on Arbitrum Sepolia.
const VERDICT_VERIFIER: Address = address!("0xe16E8767EC1DA59Ef0D9Bc7851637E4D22352d96");

fn input_of(r: &CountersignRequest, out: &Countersigned) -> CountersignInput {
    let reg = register_request();
    let cfg = config(None);
    let trace = trace(out);
    CountersignInput {
        payload_sd: reg.payload_sd,
        disclosures: reg.disclosures,
        cart: r.cart.clone(),
        unit: r.unit.clone(),
        evidence: r.evidence.clone(),
        now_ms: out.observation.now_ms,
        budget_left_minor: out.observation.budget_left_minor,
        request_id: B256::new(out.countersign.request_id.0),
        evidence_root: B256::new(out.countersign.evidence_root.0),
        expires_at: out.countersign.expires_at.parse().unwrap(),
        chain_id: cfg.chain_id,
        verifying_contract: cfg.verifying_contract,
        oci_digest: trace["engine"]["oci_digest"].as_str().unwrap().to_owned(),
        canonicalizer: trace["engine"]["canonicalizer"]
            .as_str()
            .unwrap()
            .to_owned(),
    }
}

fn assert_recomputed(r: &CountersignRequest, out: &Countersigned) -> CountersignInput {
    let input = input_of(r, out);
    let got = recompute(&input).unwrap();
    assert_eq!(got.trace_jcs, out.trace_jcs.0);
    assert_eq!(got.countersign.evalHash.0, out.countersign.eval_hash.0);
    assert_eq!(got.digest, out.digest.0);
    input
}

fn countersigned(f: &CartFixture, n: u128) -> (CountersignRequest, Countersigned) {
    let issued = register();
    let r = countersign_request(&issued, f, request_id(n), None);
    let out = leg_a().countersign(&r, at(NOW + 10)).unwrap();
    (r, out)
}

#[test]
fn recomputes_an_allow() {
    let (r, out) = countersigned(&CartFixture::demo(), 1);
    assert_eq!(out.countersign.decision, "1");
    let mut input = assert_recomputed(&r, &out);

    // The vector is this ALLOW for the demo agent under the Arbitrum Sepolia `VerdictVerifier`'s domain, so a fork of
    // the chain can lock a coverage with it and dispute that coverage with its proof.
    input.payload_sd["agent"]["operator"]["agent_id"] = json!(DEMO_AGENT_ID);
    input.verifying_contract = VERDICT_VERIFIER;
    let got = recompute(&input).unwrap();
    assert_eq!(got.countersign.decision, 1);
    assert_eq!(got.countersign.agentId, U256::from(351));
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/countersign-allow.json");
    let vector = json!({
        "input": input,
        "eval_hash": got.countersign.evalHash.to_string(),
        "digest": B256::new(got.digest).to_string(),
        "h_sd": B256::new(h_sd(&input.payload_sd).unwrap()).to_string(),
        "countersign": countersign_json(&got.countersign),
    });
    if std::env::var_os("KEELSON_WRITE_VECTORS").is_some() {
        std::fs::write(&path, serde_json::to_string_pretty(&vector).unwrap() + "\n").unwrap();
    }
    let stored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(stored, vector);
}

/// The countersign as the contract vectors write it: every field a string.
fn countersign_json(c: &Countersign) -> Value {
    json!({
        "requestId": c.requestId.to_string(),
        "mandateHash": c.mandateHash.to_string(),
        "mandateCommitment": c.mandateCommitment.to_string(),
        "cartHash": c.cartHash.to_string(),
        "agentId": c.agentId.to_string(),
        "merchantId": c.merchantId.to_string(),
        "amount": c.amount.to_string(),
        "currency": c.currency.to_string(),
        "category": c.category.to_string(),
        "evidenceRoot": c.evidenceRoot.to_string(),
        "evalHash": c.evalHash.to_string(),
        "policySetHash": c.policySetHash.to_string(),
        "decision": c.decision.to_string(),
        "failedFieldsMask": c.failedFieldsMask.to_string(),
        "issuedAt": c.issuedAt.to_string(),
        "expiresAt": c.expiresAt.to_string(),
    })
}

#[test]
fn recomputes_a_policy_deny() {
    let (r, out) = countersigned(&CartFixture::bundle(), 2);
    assert_eq!(out.countersign.decision, "2");
    assert_ne!(mask(&out), 0);
    assert_recomputed(&r, &out);
}

#[test]
fn recomputes_a_canonicalizer_deny() {
    let (r, out) = countersigned(&CartFixture::breakdown_mismatch(), 3);
    assert_eq!(
        trace(&out)["errors"],
        json!(["canon.amount_breakdown_mismatch"])
    );
    assert_recomputed(&r, &out);
}

#[test]
fn recomputes_leg_b_under_leg_a_observation() {
    let issued = register();
    let f = CartFixture::demo();
    let r = countersign_request(&issued, &f, request_id(4), None);
    let a = leg_a().countersign(&r, at(NOW + 10)).unwrap();
    let mut rb = r.clone();
    rb.observation = Some(a.observation.clone());
    let b = leg_b().countersign(&rb, at(NOW + 11)).unwrap();
    assert_eq!(a.digest.0, b.digest.0);
    assert_recomputed(&rb, &b);
}

#[test]
fn a_changed_input_changes_the_digest() {
    let (r, out) = countersigned(&CartFixture::demo(), 5);
    let mut input = input_of(&r, &out);
    input.budget_left_minor -= 1;
    let got = recompute(&input).unwrap();
    assert_ne!(got.digest, out.digest.0);
    let mut input = input_of(&r, &out);
    input.verifying_contract = Address::repeat_byte(1);
    assert_ne!(recompute(&input).unwrap().digest, out.digest.0);
}
