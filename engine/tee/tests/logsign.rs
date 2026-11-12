//! Leg A's log checkpoint signer: it signs only checkpoints that extend the last one it signed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use keelson_tee::logsign::{LogKey, LogSigner, SignError, SignRequest, verify_consistency};
use keelson_tee::{Root, UserRecords};
use serde_json::Value;
use sha2::Digest;
use zeroize::Zeroizing;

const ORIGIN: &str = "log.keelson.finance/alibi/2026-1";
/// Nothing anchored on chain.
const FLOOR: Option<(u64, [u8; 32])> = Some((0, [0; 32]));

#[derive(Default)]
struct Records(Mutex<HashMap<String, Vec<u8>>>);

impl UserRecords for Records {
    fn get(&self, key: &str) -> Option<Vec<u8>> {
        self.0.lock().unwrap().get(key).cloned()
    }

    fn insert_new(&self, key: &str, record: Vec<u8>) -> bool {
        let mut map = self.0.lock().unwrap();
        if map.contains_key(key) {
            return false;
        }
        map.insert(key.into(), record);
        true
    }
}

fn hash(v: &Value) -> [u8; 32] {
    let s = v.as_str().unwrap().trim_start_matches("0x");
    let mut out = [0; 32];
    alloy_primitives::hex::decode_to_slice(s, &mut out).unwrap();
    out
}

/// RFC 6962 vectors over the conformance tree, built and checked with transparency-dev/merkle.
fn vectors() -> Value {
    serde_json::from_str(include_str!("../../../contracts/test/vectors/rfc6962.json")).unwrap()
}

#[test]
fn consistency_matches_transparency_dev() {
    let v = vectors();
    let mut checked = 0;
    for c in v["consistency"].as_array().unwrap() {
        let (size1, size2) = (c["size1"].as_u64().unwrap(), c["size2"].as_u64().unwrap());
        if size1 == 0 || size1 >= size2 {
            continue;
        }
        let proof: Vec<[u8; 32]> = c["proof"].as_array().unwrap().iter().map(hash).collect();
        let ok = verify_consistency(size1, size2, &hash(&c["root1"]), &hash(&c["root2"]), &proof);
        assert_eq!(ok, c["ok"].as_bool().unwrap(), "{size1} -> {size2}");
        checked += 1;
    }
    assert!(checked > 1_000);
    let s = &v["sandboxConsistency"][0];
    let proof: Vec<[u8; 32]> = s["proof"].as_array().unwrap().iter().map(hash).collect();
    assert!(verify_consistency(
        1,
        54,
        &hash(&s["root1"]),
        &hash(&s["root2"]),
        &proof
    ));
}

struct Leg {
    signer: LogSigner,
    root: Root,
    records: Arc<Records>,
}

fn key() -> LogKey {
    LogKey::new(ORIGIN, &Zeroizing::new([7; 32]), vec![])
}

fn leg() -> Leg {
    let records = Arc::new(Records::default());
    Leg {
        signer: LogSigner::new(vec![key()], records.clone()),
        root: Root::new(&[1; 32]),
        records,
    }
}

/// The conformance trees of the vectors at `size`, as checkpoint bodies of the sandbox origin.
fn tree(size: u64) -> (String, [u8; 32]) {
    let v = vectors();
    let c = v["consistency"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["size2"].as_u64() == Some(size) && c["ok"].as_bool() == Some(true))
        .unwrap();
    let root = hash(&c["root2"]);
    (
        format!("{ORIGIN}\n{size}\n{}\n", STANDARD.encode(root)),
        root,
    )
}

fn proof(from: u64, to: u64) -> Vec<String> {
    let v = vectors();
    let c = v["consistency"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| {
            c["size1"].as_u64() == Some(from)
                && c["size2"].as_u64() == Some(to)
                && c["ok"].as_bool() == Some(true)
        })
        .unwrap();
    c["proof"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| STANDARD.encode(hash(h)))
        .collect()
}

fn request(checkpoint: &str, from: Option<u64>, consistency: Vec<String>) -> SignRequest {
    serde_json::from_value(serde_json::json!({
        "checkpoint": checkpoint,
        "from_size": from,
        "consistency": consistency,
    }))
    .unwrap()
}

#[test]
fn signs_the_first_tree_then_only_extensions() {
    let leg = leg();
    let (t8, _) = tree(8);
    let signed = leg
        .signer
        .sign(&leg.root, FLOOR, &request(&t8, None, vec![]))
        .unwrap();
    let public = VerifyingKey::from_bytes(&key().public_key()).unwrap();
    let sig = Signature::from_slice(&STANDARD.decode(&signed.signature).unwrap()).unwrap();
    public.verify(t8.as_bytes(), &sig).unwrap();
    assert_eq!(signed.vkey, key().vkey());

    // The same tree again, as the log re-signs it while it does not grow.
    leg.signer
        .sign(&leg.root, FLOOR, &request(&t8, None, vec![]))
        .unwrap();

    let (t13, _) = tree(13);
    leg.signer
        .sign(&leg.root, FLOOR, &request(&t13, Some(8), proof(8, 13)))
        .unwrap();

    // Behind, or from a size that is no longer the latest.
    let refused = |r: SignRequest| leg.signer.sign(&leg.root, FLOOR, &r).unwrap_err();
    assert_eq!(
        refused(request(&t8, None, vec![])),
        SignError::NotExtending { latest: Some(13) }
    );
    let (t20, _) = tree(20);
    assert_eq!(
        refused(request(&t20, Some(8), proof(8, 20))),
        SignError::NotExtending { latest: Some(13) }
    );
    leg.signer
        .sign(&leg.root, FLOOR, &request(&t20, Some(13), proof(13, 20)))
        .unwrap();
}

#[test]
fn refuses_a_fork_at_any_size() {
    let leg = leg();
    let (t8, _) = tree(8);
    leg.signer
        .sign(&leg.root, FLOOR, &request(&t8, None, vec![]))
        .unwrap();
    let fork = format!("{ORIGIN}\n8\n{}\n", STANDARD.encode([9; 32]));
    assert_eq!(
        leg.signer
            .sign(&leg.root, FLOOR, &request(&fork, None, vec![]))
            .unwrap_err(),
        SignError::NotExtending { latest: Some(8) }
    );
    // A larger tree whose proof does not join the signed one.
    let (t13, _) = tree(13);
    let mut bad = proof(8, 13);
    bad[0] = STANDARD.encode([3; 32]);
    assert!(matches!(
        leg.signer
            .sign(&leg.root, FLOOR, &request(&t13, Some(8), bad)),
        Err(SignError::NotExtending { .. })
    ));
}

#[test]
fn a_restarted_leg_recovers_the_history_from_its_records() {
    let leg = leg();
    let (t8, _) = tree(8);
    let (t13, _) = tree(13);
    leg.signer
        .sign(&leg.root, FLOOR, &request(&t8, None, vec![]))
        .unwrap();
    leg.signer
        .sign(&leg.root, FLOOR, &request(&t13, Some(8), proof(8, 13)))
        .unwrap();

    let restarted = LogSigner::new(vec![key()], leg.records.clone());
    assert_eq!(
        restarted
            .sign(&leg.root, FLOOR, &request(&t8, None, vec![]))
            .unwrap_err(),
        SignError::NotExtending { latest: Some(13) }
    );
    restarted
        .sign(&leg.root, FLOOR, &request(&t13, None, vec![]))
        .unwrap();
    // Records sealed under another root do not open.
    let other = LogSigner::new(vec![key()], leg.records.clone());
    assert_eq!(
        other
            .sign(&Root::new(&[2; 32]), FLOOR, &request(&t13, None, vec![]))
            .unwrap_err(),
        SignError::Records
    );
}

#[test]
fn refuses_other_origins_and_malformed_bodies() {
    let leg = leg();
    let other = format!(
        "log.keelson.finance/conformance/2026-1\n1\n{}\n",
        STANDARD.encode([0; 32])
    );
    assert_eq!(
        leg.signer
            .sign(&leg.root, FLOOR, &request(&other, None, vec![]))
            .unwrap_err(),
        SignError::Origin
    );
    for body in [
        format!("{ORIGIN}\n08\n{}\n", STANDARD.encode([0; 32])),
        format!("{ORIGIN}\n8\n{}\next\n", STANDARD.encode([0; 32])),
        format!("{ORIGIN}\n8\n{}", STANDARD.encode([0; 32])),
        format!("{ORIGIN}\n8\nAAAA\n"),
    ] {
        assert_eq!(
            leg.signer
                .sign(&leg.root, FLOOR, &request(&body, None, vec![]))
                .unwrap_err(),
            SignError::Format,
            "{body:?}"
        );
    }
}

#[test]
fn a_leg_with_no_history_signs_only_extensions_of_the_anchor() {
    let leg = leg();
    let (_, r8) = tree(8);
    let (t13, _) = tree(13);
    let fork = format!("{ORIGIN}\n13\n{}\n", STANDARD.encode([9; 32]));
    let anchored = Some((8, r8));
    // The chain could not be read: nothing is signed.
    assert_eq!(
        leg.signer
            .sign(&leg.root, None, &request(&t13, Some(8), proof(8, 13)))
            .unwrap_err(),
        SignError::NoFloor
    );
    assert!(leg.signer.needs_floor(&leg.root, ORIGIN).unwrap());
    for bad in [
        request(&fork, Some(8), proof(8, 13)),
        request(&t13, None, vec![]),
        request(
            &format!("{ORIGIN}\n5\n{}\n", STANDARD.encode([1; 32])),
            None,
            vec![],
        ),
    ] {
        assert_eq!(
            leg.signer.sign(&leg.root, anchored, &bad).unwrap_err(),
            SignError::NotExtending { latest: Some(8) }
        );
    }
    leg.signer
        .sign(&leg.root, anchored, &request(&t13, Some(8), proof(8, 13)))
        .unwrap();
    assert!(!leg.signer.needs_floor(&leg.root, ORIGIN).unwrap());
}

#[test]
fn the_empty_tree_is_extended_without_a_proof() {
    let leg = leg();
    let empty = format!(
        "{ORIGIN}\n0\n{}\n",
        STANDARD.encode(<[u8; 32]>::from(sha2::Sha256::digest(b"")))
    );
    leg.signer
        .sign(&leg.root, FLOOR, &request(&empty, None, vec![]))
        .unwrap();
    let (t8, _) = tree(8);
    leg.signer
        .sign(&leg.root, FLOOR, &request(&t8, Some(0), vec![]))
        .unwrap();
}

#[test]
fn signs_the_receipt_root_with_its_own_key() {
    let leg = leg();
    let (t8, root) = tree(8);
    let signed = leg
        .signer
        .sign(&leg.root, FLOOR, &request(&t8, None, vec![]))
        .unwrap();
    let receipt = key().receipt_public_key();
    assert_ne!(
        receipt,
        key().public_key(),
        "the receipt key is not the note key"
    );
    assert_eq!(
        receipt,
        key().receipt_public_key(),
        "the same seed gives the same key"
    );
    let tbs = keelson_core::statement::to_be_signed(
        &keelson_core::statement::receipt_protected(&receipt, ORIGIN),
        &root,
    );
    let sig = Signature::from_slice(&STANDARD.decode(&signed.receipt_signature).unwrap()).unwrap();
    VerifyingKey::from_bytes(&receipt)
        .unwrap()
        .verify(&tbs, &sig)
        .unwrap();
}
