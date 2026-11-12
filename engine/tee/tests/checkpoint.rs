mod common;

use std::sync::Arc;

use alloy_primitives::{Address, B256, Signature, keccak256};
use alloy_sol_types::SolStruct;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use common::*;
use http_body_util::BodyExt;
use keelson_core::eip712::Checkpoint;
use keelson_tee::checkpoint::{CheckpointError, ORIGINS, origin, verify_checkpoint};
use keelson_tee::kms::{APP_ID, KMS_ROOT, verify_chain};
use keelson_tee::logsign::key_domain;
use keelson_tee::server::{AppState, router};
use keelson_tee::wire::{CheckpointRequest, CheckpointSigned};
use keelson_tee::{EngineError, Signer};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use tower::ServiceExt;

const SANDBOX: &str = include_str!("data/checkpoints/alibi-2026-1-823.note");
const LIVE: &str = include_str!("data/checkpoints/alibi-live-2026-1-0.note");
const CONFORMANCE: &str = include_str!("data/checkpoints/conformance-2026-1-16.note");
const SEPOLIA: u64 = 421_614;
const ONE: u64 = 42_161;

/// After every cosignature in the test notes.
fn now() -> OffsetDateTime {
    at(1_794_500_000)
}

/// The origin hash, size and root of the verified note.
fn verify(note: &str, chain_id: u64) -> Result<(B256, u64, B256), CheckpointError> {
    fields(verify_checkpoint(note.as_bytes(), chain_id, now(), &[]))
}

fn fields(c: Result<Checkpoint, CheckpointError>) -> Result<(B256, u64, B256), CheckpointError> {
    c.map(|c| (c.origin, c.treeSize, c.rootHash))
}

/// The note's lines, keeping their newlines.
fn lines(note: &str) -> Vec<&str> {
    note.split_inclusive('\n').collect()
}

fn root_of(note: &str) -> B256 {
    B256::from_slice(&STANDARD.decode(note.lines().nth(2).unwrap()).unwrap())
}

#[test]
fn the_sandbox_note_verifies_for_arbitrum_sepolia() {
    assert_eq!(
        verify(SANDBOX, SEPOLIA),
        Ok((
            keccak256("log.keelson.finance/alibi/2026-1"),
            823,
            root_of(SANDBOX)
        ))
    );
}

#[test]
fn an_origin_anchors_only_on_its_chain() {
    assert_eq!(verify(SANDBOX, ONE), Err(CheckpointError::Chain));
    assert_eq!(verify(LIVE, SEPOLIA), Err(CheckpointError::Chain));
    let (origin, size, _) = verify(LIVE, ONE).unwrap();
    assert_eq!(origin, keccak256("log.keelson.finance/alibi-live/2026-1"));
    assert_eq!(size, 0);
}

#[test]
fn the_conformance_note_needs_no_cosignature() {
    let (origin, size, _) = verify(CONFORMANCE, SEPOLIA).unwrap();
    assert_eq!(origin, keccak256("log.keelson.finance/conformance/2026-1"));
    assert_eq!(size, 16);
}

#[test]
fn a_flipped_byte_in_the_log_signature_is_refused() {
    let l = lines(SANDBOX);
    let log_line = l
        .iter()
        .position(|line| line.starts_with("— log.keelson.finance/alibi/2026-1 "))
        .unwrap();
    let (prefix, sig) = l[log_line].trim_end().rsplit_once(' ').unwrap();
    let mut raw = STANDARD.decode(sig).unwrap();
    raw[10] ^= 1;
    let mut tampered = l.clone();
    let line = format!("{prefix} {}\n", STANDARD.encode(raw));
    tampered[log_line] = &line;
    assert_eq!(
        verify(&tampered.concat(), SEPOLIA),
        Err(CheckpointError::LogSignature)
    );
}

#[test]
fn a_note_without_the_log_signature_is_refused() {
    let note: String = lines(CONFORMANCE)
        .into_iter()
        .filter(|l| !l.starts_with("— "))
        .collect();
    assert_eq!(verify(&note, SEPOLIA), Err(CheckpointError::Format));
}

#[test]
fn one_witness_is_not_a_quorum() {
    let witnesses: Vec<&str> = lines(SANDBOX)
        .into_iter()
        .filter(|l| l.starts_with("— witness-"))
        .collect();
    assert_eq!(witnesses.len(), 2);
    let without_one: String = lines(SANDBOX)
        .into_iter()
        .filter(|l| *l != witnesses[1])
        .collect();
    assert_eq!(verify(&without_one, SEPOLIA), Err(CheckpointError::Quorum));
    let twice = format!("{without_one}{}", witnesses[0]);
    assert_eq!(verify(&twice, SEPOLIA), Err(CheckpointError::Quorum));
}

#[test]
fn a_cosignature_from_the_future_does_not_count() {
    let early = at(1_794_300_000);
    assert_eq!(
        fields(verify_checkpoint(SANDBOX.as_bytes(), SEPOLIA, early, &[])),
        Err(CheckpointError::Quorum)
    );
}

#[test]
fn extension_lines_and_malformed_bodies_are_refused() {
    let l = lines(SANDBOX);
    let with_extension = [&l[..3], &["extension\n"], &l[3..]].concat().concat();
    assert_eq!(
        verify(&with_extension, SEPOLIA),
        Err(CheckpointError::Format)
    );
    let no_separator = SANDBOX.replacen("\n\n", "\n", 1);
    assert_eq!(verify(&no_separator, SEPOLIA), Err(CheckpointError::Format));
    let leading_zero = SANDBOX.replacen("\n823\n", "\n0823\n", 1);
    assert_eq!(verify(&leading_zero, SEPOLIA), Err(CheckpointError::Format));
    let short_root = SANDBOX.replacen(l[2], "AAAA\n", 1);
    assert_eq!(verify(&short_root, SEPOLIA), Err(CheckpointError::Format));
    assert_eq!(
        fields(verify_checkpoint(b"\xff\xfe", SEPOLIA, now(), &[])),
        Err(CheckpointError::Format)
    );
}

#[test]
fn an_unknown_origin_is_refused() {
    let other = SANDBOX.replacen("log.keelson.finance/alibi/2026-1\n", "log.example/x\n", 1);
    assert_eq!(verify(&other, SEPOLIA), Err(CheckpointError::Origin));
}

#[test]
fn a_changed_size_breaks_the_log_signature() {
    let other = SANDBOX.replacen("\n823\n", "\n824\n", 1);
    assert_eq!(verify(&other, SEPOLIA), Err(CheckpointError::LogSignature));
}

/// The keys of `services/log/policy/<origin>.policy`: its Ed25519 log key and its witnesses.
fn policy(file: &str) -> (String, Vec<String>) {
    let path = format!(
        "{}/../../services/log/policy/{file}.policy",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(path).unwrap();
    let mut log = None;
    let mut witnesses = vec![];
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        match fields.as_slice() {
            ["log", vkey, ..] => {
                let key = STANDARD
                    .decode(vkey.splitn(3, '+').nth(2).unwrap())
                    .unwrap();
                if key[0] == 0x01 {
                    log = Some(vkey.to_string());
                }
            }
            ["witness", _, vkey, ..] => witnesses.push(vkey.to_string()),
            _ => {}
        }
    }
    (log.unwrap(), witnesses)
}

/// Whether `vkey` is the Ed25519 log key leg A's app on the on-chain KMS derives for `origin`,
/// which the engine trusts at boot next to its pinned key once the chain verifies.
fn issued_to_leg_a(origin: &str, vkey: &str) -> bool {
    let keys: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/onchain-kms/getkey-chain.json")).unwrap();
    let encoded = STANDARD
        .decode(vkey.splitn(3, '+').nth(2).unwrap())
        .unwrap();
    let Some((&0x01, public)) = encoded.split_first() else {
        return false;
    };
    keys.iter().filter(|k| k["origin"] == origin).any(|k| {
        let chain: Vec<Vec<u8>> = k["chain"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| hex_bytes(l.as_str().unwrap()))
            .collect();
        verify_chain(
            "ed25519",
            &key_domain(origin),
            public,
            &chain,
            &APP_ID,
            &KMS_ROOT,
        )
    })
}

#[test]
fn only_leg_a_kms_keys_count_as_issued() {
    let new =
        "log.keelson.finance/alibi/2026-1+bdddc67c+AUP8v6W0TKgm6ZGJeE+DLSR4jNCgOetpzwmiLC4egkK/";
    assert!(issued_to_leg_a("log.keelson.finance/alibi/2026-1", new));
    assert!(!issued_to_leg_a(
        "log.keelson.finance/alibi-live/2026-1",
        new
    ));
    assert!(!issued_to_leg_a(
        "log.keelson.finance/alibi/2026-1",
        ORIGINS[0].log_key
    ));
    assert!(!issued_to_leg_a(
        "log.keelson.finance/conformance/2026-1",
        ORIGINS[2].log_key
    ));
}

#[test]
fn the_origins_carry_the_keys_of_the_log_policies() {
    assert_eq!(ORIGINS.len(), 3);
    for (name, file, chain_id, quorum) in [
        (
            "log.keelson.finance/alibi/2026-1",
            "alibi-2026-1",
            SEPOLIA,
            2,
        ),
        (
            "log.keelson.finance/alibi-live/2026-1",
            "alibi-live-2026-1",
            ONE,
            2,
        ),
        (
            "log.keelson.finance/conformance/2026-1",
            "conformance-2026-1",
            SEPOLIA,
            0,
        ),
    ] {
        let o = origin(name).unwrap();
        let (log, witnesses) = policy(file);
        assert!(
            log == o.log_key || issued_to_leg_a(name, &log),
            "{name}: the engine trusts neither its pinned key nor leg A's KMS key for {log}"
        );
        assert_eq!(o.chain_id, chain_id, "{name}");
        assert_eq!(o.quorum, quorum, "{name}");
        if quorum > 0 {
            assert_eq!(o.witnesses, witnesses, "{name}");
        } else {
            assert!(o.witnesses.is_empty(), "{name}");
        }
    }
}

fn recover(digest: B256, signature: &[u8]) -> Address {
    let sig = Signature::from_raw(signature).unwrap();
    assert!(signature[64] == 27 || signature[64] == 28);
    sig.recover_address_from_prehash(&digest).unwrap()
}

#[test]
fn sign_checkpoint_matches_the_viem_digest() {
    let vectors: Vec<Value> = serde_json::from_str(include_str!(
        "../../../packages/core/test/vectors/eip712.json"
    ))
    .unwrap();
    let signer = Signer::generate();
    let mut checked = 0;
    for v in vectors
        .iter()
        .filter(|v| v["input"]["primaryType"] == "Checkpoint")
    {
        let input = &v["input"];
        let m = &input["message"];
        let c = Checkpoint {
            origin: m["origin"].as_str().unwrap().parse().unwrap(),
            treeSize: m["treeSize"].as_str().unwrap().parse().unwrap(),
            rootHash: m["rootHash"].as_str().unwrap().parse().unwrap(),
        };
        let domain = keelson_core::domain(
            input["chainId"].as_u64().unwrap(),
            input["verifyingContract"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
        )
        .unwrap();
        let expected: B256 = v["expected"].as_str().unwrap().parse().unwrap();
        assert_eq!(c.eip712_signing_hash(&domain), expected);
        let signature = signer.sign_checkpoint(&c, &domain).unwrap();
        assert_eq!(recover(expected, &signature), signer.address());
        checked += 1;
    }
    assert_eq!(checked, 2);
}

#[test]
fn the_engine_signs_under_the_requested_chain() {
    let engine = leg_b();
    let signed = engine
        .sign_checkpoint(
            &CheckpointRequest {
                signed_note: SANDBOX.into(),
                chain_id: None,
            },
            now(),
        )
        .unwrap();
    assert_eq!(signed.chain_id, SEPOLIA);
    assert_eq!(signed.tree_size, "823");
    assert_eq!(
        recover(B256::new(signed.digest.0), &signed.signature.0),
        engine.signer()
    );
    let refused = engine.sign_checkpoint(
        &CheckpointRequest {
            signed_note: SANDBOX.into(),
            chain_id: Some(ONE),
        },
        now(),
    );
    assert_eq!(
        refused,
        Err(EngineError::Checkpoint(CheckpointError::Chain))
    );
    let live = engine
        .sign_checkpoint(
            &CheckpointRequest {
                signed_note: LIVE.into(),
                chain_id: Some(ONE),
            },
            now(),
        )
        .unwrap();
    assert_eq!(live.chain_id, ONE);
}

const TOKEN: &str = "k-test-token";

async fn post(body: Value, token: Option<&str>) -> (StatusCode, Value) {
    let app = router(Arc::new(
        AppState::new(leg_a(), Sha256::digest(TOKEN).into()).with_clock(now),
    ));
    let mut req = Request::post("/v1/checkpoint").header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let response = app
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn the_route_needs_the_token() {
    let (status, body) = post(json!({ "signed_note": SANDBOX }), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["code"], "unauthorized");
}

#[tokio::test]
async fn the_route_signs_a_witnessed_checkpoint() {
    let (status, body) = post(json!({ "signed_note": SANDBOX }), Some(TOKEN)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let signed: CheckpointSigned = serde_json::from_value(body).unwrap();
    assert_eq!(
        signed.origin.0,
        keccak256("log.keelson.finance/alibi/2026-1").0
    );
    assert_eq!(signed.root_hash.0, root_of(SANDBOX).0);
    assert_eq!(
        recover(B256::new(signed.digest.0), &signed.signature.0),
        signed.signer
    );
}

#[tokio::test]
async fn the_route_answers_the_refusal_code() {
    let tampered = SANDBOX.replacen("\n823\n", "\n824\n", 1);
    let (status, body) = post(json!({ "signed_note": tampered }), Some(TOKEN)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "checkpoint_log_signature");
    let big = "x".repeat(17 * 1024);
    let (status, _) = post(json!({ "signed_note": big }), Some(TOKEN)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
}
