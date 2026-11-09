use std::collections::BTreeSet;

use keelson_policy::{
    ATTRIBUTION_SCHEMA_SRC, AttributionBug, Cvc5, Liable, RULES, Verdict, attribution_policy_src,
    attribution_sets, prove_attribution, prove_attribution_sets, replay_attribution,
};
use sha2::{Digest, Sha256};

const BUNDLE: &str = include_str!("../proofs/attribution-bundle.json");

fn solver() -> Cvc5 {
    Cvc5::from_env().expect("cvc5 1.3.1 is on PATH or named by CVC5")
}

fn sha256_tag(bytes: impl AsRef<[u8]>) -> String {
    let hex: String = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("sha256:{hex}")
}

#[test]
fn the_table_is_total_exclusive_and_safe() {
    let bundle = prove_attribution(&solver()).expect("the solver answers every query");
    assert_eq!(bundle.policy_set_hash, sha256_tag(attribution_policy_src()));
    assert_eq!(bundle.schema_hash, sha256_tag(ATTRIBUTION_SCHEMA_SRC));

    for r in &bundle.results {
        assert_eq!(
            r.verdict,
            Verdict::Verified,
            "{} {}: {:?}",
            r.check,
            r.subject,
            r.counterexample
        );
    }
    let checks: BTreeSet<_> = bundle
        .results
        .iter()
        .map(|r| (r.check.as_str(), r.subject.as_str()))
        .collect();
    assert_eq!(checks.len(), bundle.results.len(), "no check repeats");
    assert_eq!(bundle.results.len(), 1 + 6 + 3 + RULES.len());
    assert!(checks.contains(&("total", "attribute/rules")));
    for pair in [
        "operator|keelson",
        "operator|merchant",
        "operator|user",
        "keelson|merchant",
        "keelson|user",
        "merchant|user",
    ] {
        assert!(
            checks.contains(&("exclusive", format!("attribute/{pair}").as_str())),
            "{pair}"
        );
    }
    for (check, subject) in [
        ("keelson_needs_proof", "attribute/keelson"),
        ("slash_needs_fault", "attribute/operator"),
        ("alibi_defends_user", "attribute/user"),
    ] {
        assert!(checks.contains(&(check, subject)), "{check}");
    }

    for rule in &RULES {
        let subject = format!("attribute/{}", rule.name());
        let r = bundle
            .results
            .iter()
            .find(|r| r.check == "reachable" && r.subject == subject)
            .unwrap_or_else(|| panic!("{subject}"));
        let witness = r.witness.as_ref().expect("a reachable rule has a witness");
        assert_eq!(
            replay_attribution(witness, attribution_sets()).unwrap(),
            vec![rule.liable],
            "{subject}"
        );
    }
}

#[test]
fn without_precedence_two_parties_are_liable() {
    let sets = AttributionBug::NoPrecedence.sets();
    let results = prove_attribution_sets(&solver(), &sets).unwrap();
    let overlaps: Vec<_> = results
        .iter()
        .filter(|r| r.check == "exclusive" && r.verdict == Verdict::Counterexample)
        .collect();
    assert!(!overlaps.is_empty());
    for r in overlaps {
        let cex = r.counterexample.as_ref().unwrap();
        let parties = replay_attribution(cex, &sets).unwrap();
        assert!(parties.len() >= 2, "{}: {parties:?}", r.subject);
        assert_eq!(
            replay_attribution(cex, attribution_sets()).unwrap().len(),
            1
        );
    }
}

#[test]
fn without_the_gray_rule_some_dispute_has_no_party() {
    let sets = AttributionBug::DropGray.sets();
    let results = prove_attribution_sets(&solver(), &sets).unwrap();
    let total = results.iter().find(|r| r.check == "total").unwrap();
    assert_eq!(total.verdict, Verdict::Counterexample);
    let cex = total.counterexample.as_ref().unwrap();
    assert_eq!(replay_attribution(cex, &sets).unwrap(), vec![]);
    assert_eq!(cex["context"]["failed_gray"], true);
    assert_eq!(
        replay_attribution(cex, attribution_sets()).unwrap(),
        vec![Liable::User]
    );
    assert!(
        results
            .iter()
            .filter(|r| r.check != "total")
            .all(|r| r.verdict == Verdict::Verified),
        "only totality breaks"
    );
}

#[test]
fn committed_bundle_is_what_the_prover_writes() {
    let fresh =
        serde_json::to_string_pretty(&prove_attribution(&solver()).unwrap()).unwrap() + "\n";
    assert!(
        fresh == BUNDLE,
        "proofs/attribution-bundle.json is stale: run `cargo run -p keelson-policy --bin prove -- --attribution --out engine/policy/proofs/attribution-bundle.json`"
    );
}
