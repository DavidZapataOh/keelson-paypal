use std::collections::BTreeSet;

use cedar_policy::Effect;
use keelson_policy::{
    CVC5_VERSION, Cvc5, POLICY_SET_SRC, SPEC_SRC, Verdict, policies, policy_set_hash_tag,
    prove_all, schema_hash_tag,
};

#[test]
fn every_check_is_verified() {
    let solver = Cvc5::from_env().expect("cvc5 1.3.1 is on PATH or named by CVC5");
    assert_eq!(solver.version(), CVC5_VERSION);
    let bundle = prove_all(&solver).expect("the solver answers every query");

    assert_eq!(bundle.symcc, "0.8.1");
    assert_eq!(bundle.cvc5, "1.3.1");
    assert_eq!(bundle.cedar_policy, "4.14.1");
    assert_eq!(bundle.policy_set_hash, policy_set_hash_tag());
    assert_eq!(bundle.schema_hash, schema_hash_tag());
    assert!(bundle.spec_hash.starts_with("sha256:"));

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
    assert!(checks.contains(&("equivalent", "policy_set=spec")));
    assert!(checks.contains(&("satisfiable", "policy_set")));
    assert!(checks.contains(&("not_always_allows", "policy_set")));
    let forbids: Vec<_> = policies()
        .policies()
        .filter(|p| p.effect() == Effect::Forbid)
        .map(|p| p.id().to_string())
        .collect();
    assert_eq!(forbids.len(), 12);
    for id in &forbids {
        assert!(checks.contains(&("never_errors", id.as_str())), "{id}");
    }
    for kind in [
        "extra:max_unit_price",
        "extra:deny_merchant",
        "extra:deny_category",
        "extra:require_return_days",
    ] {
        assert!(checks.contains(&("never_errors", kind)), "{kind}");
    }

    let json = serde_json::to_value(&bundle).unwrap();
    assert!(json["results"][0].get("counterexample").is_none());
    assert_eq!(json["results"][0]["verdict"], "verified");
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
