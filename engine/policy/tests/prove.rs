use std::collections::BTreeSet;

use cedar_policy::Effect;
use keelson_policy::{
    CEDAR_POLICY_VERSION, CVC5_VERSION, Cvc5, Decision, POLICY_SET_SRC, SCHEMA_SRC, SPEC_SRC,
    SYMCC_VERSION, Verdict, policies, prove_all, replay, spec,
};
use sha2::{Digest, Sha256};

fn sha256_tag(bytes: impl AsRef<[u8]>) -> String {
    let hex: String = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("sha256:{hex}")
}

#[test]
fn tool_versions_are_the_pinned_ones() {
    let manifest = include_str!("../Cargo.toml");
    assert!(manifest.contains(&format!("cedar-policy-symcc = \"={SYMCC_VERSION}\"")));
    assert!(manifest.contains(&format!("cedar-policy = \"={CEDAR_POLICY_VERSION}\"")));
}

#[test]
fn every_check_is_verified() {
    let solver = Cvc5::from_env().expect("cvc5 1.3.1 is on PATH or named by CVC5");
    assert_eq!(solver.version(), CVC5_VERSION);
    let bundle = prove_all(&solver).expect("the solver answers every query");

    assert_eq!(bundle.symcc, "0.8.1");
    assert_eq!(bundle.cvc5, "1.3.1");
    assert_eq!(bundle.cedar_policy, "4.14.1");
    assert_eq!(bundle.policy_set_hash, sha256_tag(POLICY_SET_SRC));
    assert_eq!(bundle.schema_hash, sha256_tag(SCHEMA_SRC));
    assert_eq!(bundle.spec_hash, sha256_tag(SPEC_SRC));
    assert!(
        serde_json::to_value(&bundle)
            .unwrap()
            .get("cvc5_sha256")
            .is_none(),
        "the bundle does not depend on the platform's cvc5 build"
    );

    for r in &bundle.results {
        assert_eq!(
            r.verdict,
            Verdict::Verified,
            "{} {}: {:?}",
            r.check,
            r.subject,
            r.counterexample
        );
        assert!(r.counterexample.is_none());
    }

    let checks: BTreeSet<_> = bundle
        .results
        .iter()
        .map(|r| (r.check.as_str(), r.subject.as_str()))
        .collect();
    assert_eq!(checks.len(), bundle.results.len(), "no check repeats");
    assert_eq!(bundle.results.len(), 1 + 12 + 4 + 2);
    assert!(checks.contains(&("equivalent", "checkout/policy_set=spec")));
    assert!(checks.contains(&("satisfiable", "checkout/policy_set")));
    assert!(checks.contains(&("not_always_allows", "checkout/policy_set")));
    let forbids: Vec<_> = policies()
        .policies()
        .filter(|p| p.effect() == Effect::Forbid)
        .map(|p| p.id().to_string())
        .collect();
    assert_eq!(forbids.len(), 12);
    for id in &forbids {
        let subject = format!("checkout/{id}");
        assert!(checks.contains(&("never_errors", subject.as_str())), "{id}");
    }
    for kind in [
        "checkout/extra:max_unit_price",
        "checkout/extra:deny_merchant",
        "checkout/extra:deny_category",
        "checkout/extra:require_return_days",
    ] {
        assert!(checks.contains(&("never_errors", kind)), "{kind}");
    }

    let witness = |check: &str| {
        let r = bundle.results.iter().find(|r| r.check == check).unwrap();
        r.witness.as_ref().expect("the check stores its witness")
    };
    let allowed = witness("satisfiable");
    assert_eq!(replay(allowed, policies()).unwrap(), Decision::Allow);
    assert_eq!(replay(allowed, spec()).unwrap(), Decision::Allow);
    let denied = witness("not_always_allows");
    assert_eq!(replay(denied, policies()).unwrap(), Decision::Deny);
    assert_eq!(replay(denied, spec()).unwrap(), Decision::Deny);

    let json = serde_json::to_value(&bundle).unwrap();
    assert!(json["results"][0].get("counterexample").is_none());
    assert_eq!(json["results"][0]["verdict"], "verified");

    let again = prove_all(&solver).unwrap();
    assert_eq!(
        serde_json::to_string(&again).unwrap(),
        serde_json::to_string(&bundle).unwrap(),
        "the bundle is reproducible"
    );
}

#[test]
fn spec_shares_no_policy_line_with_the_policy_set() {
    let lines = |src: &'static str| -> BTreeSet<&'static str> {
        src.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('@') && !l.starts_with("//"))
            .collect()
    };
    let shared: Vec<_> = lines(SPEC_SRC)
        .intersection(&lines(POLICY_SET_SRC))
        .copied()
        .collect();
    assert!(shared.is_empty(), "{shared:?}");
}
