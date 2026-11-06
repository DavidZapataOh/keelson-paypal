use keelson_policy::{CVC5_VERSION, Cvc5, EngineMeta, PROOF_BUNDLE_HASH, SYMCC_VERSION, prove_all};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

const BUNDLE: &str = include_str!("../proofs/proof-bundle.json");

fn bundle() -> Value {
    serde_json::from_str(BUNDLE).unwrap()
}

#[test]
fn hash_is_the_sha256_of_the_committed_bundle_in_jcs() {
    let jcs = keelson_core::jcs(&bundle()).expect("every number in the bundle is a safe integer");
    let hex: String = Sha256::digest(jcs)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(PROOF_BUNDLE_HASH, format!("sha256:{hex}"));
}

#[test]
fn committed_bundle_is_what_the_prover_writes() {
    let solver = Cvc5::from_env().expect("cvc5 1.3.1 is on PATH or named by CVC5");
    let fresh = serde_json::to_string_pretty(&prove_all(&solver).unwrap()).unwrap() + "\n";
    assert!(
        fresh == BUNDLE,
        "proofs/proof-bundle.json is stale: run `cargo run -p keelson-policy --bin prove -- --out engine/policy/proofs/proof-bundle.json`"
    );
}

fn strings<'a>(v: &'a Value, out: &mut Vec<&'a str>) {
    match v {
        Value::String(s) => out.push(s),
        Value::Array(items) => items.iter().for_each(|i| strings(i, out)),
        Value::Object(map) => map.iter().for_each(|(k, v)| {
            out.push(k);
            strings(v, out);
        }),
        _ => {}
    }
}

#[test]
fn bundle_has_no_timestamps_or_paths() {
    let bundle = bundle();
    let mut all = Vec::new();
    strings(&bundle, &mut all);
    for s in all {
        assert!(
            OffsetDateTime::parse(s, &Rfc3339).is_err(),
            "timestamp {s:?}"
        );
        assert!(!s.starts_with('/') && !s.contains(":\\"), "path {s:?}");
        assert!(
            !s.contains("/Users/") && !s.contains("/home/"),
            "path {s:?}"
        );
    }
    let mut keys: Vec<_> = bundle.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "cedar_policy",
            "cvc5",
            "policy_set_hash",
            "results",
            "schema_hash",
            "spec_hash",
            "symcc"
        ]
    );
}

#[test]
fn engine_meta_carries_the_proof_bundle_hash() {
    let meta = EngineMeta::current("sha256:oci", "sha256:canon");
    assert_eq!(meta.proof_bundle_hash, PROOF_BUNDLE_HASH);
    assert_eq!(meta.symcc, SYMCC_VERSION);
    assert_eq!(meta.cvc5, CVC5_VERSION);
    assert_eq!(meta.oci_digest, "sha256:oci");
    assert_eq!(meta.canonicalizer, "sha256:canon");
}
