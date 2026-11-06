use std::process::Command;

use cedar_policy::{Effect, PolicyId};
use keelson_policy::{
    Cvc5, Decision, ProofResult, SeedBug, Verdict, policies, prove_set, replay, spec,
};
use serde_json::Value;

fn solver() -> Cvc5 {
    Cvc5::from_env().expect("cvc5 1.3.1 is on PATH or named by CVC5")
}

fn find<'a>(results: &'a [ProofResult], check: &str, subject: &str) -> &'a ProofResult {
    results
        .iter()
        .find(|r| r.check == check && r.subject == subject)
        .unwrap_or_else(|| panic!("{check} {subject}"))
}

/// An entity reference, in either of Cedar's JSON forms.
fn uid(v: &Value) -> &Value {
    v.get("__entity").unwrap_or(v)
}

fn resource_attr<'a>(cex: &'a Value, attr: &str) -> &'a Value {
    let resource = uid(&cex["resource"]);
    let entity = cex["entities"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| uid(&e["uid"]) == resource)
        .expect("the counterexample carries the mandate entity");
    &entity["attrs"][attr]
}

#[test]
fn overflow_lets_a_cart_over_the_maximum_through() {
    let set = SeedBug::Overflow.policy_set();
    assert_eq!(set.policies().count(), policies().policies().count());
    let amount = set.policy(&PolicyId::new("amount")).unwrap();
    assert!(amount.to_string().contains("+ 1"), "{amount}");
    assert_eq!(amount.annotation("field"), Some("total"));

    let results = prove_set(&solver(), &set).unwrap();
    let errors = find(&results, "never_errors", "checkout/amount");
    assert_eq!(errors.verdict, Verdict::Counterexample);
    let errors_cex = errors.counterexample.as_ref().unwrap();
    replay(errors_cex, &set).expect("the never_errors counterexample replays");
    for r in results.iter().filter(|r| r.check == "never_errors") {
        if r.subject != "checkout/amount" {
            assert_eq!(r.verdict, Verdict::Verified, "{}", r.subject);
        }
    }

    let equivalent = find(&results, "equivalent", "checkout/policy_set=spec");
    assert_eq!(equivalent.verdict, Verdict::Counterexample);
    let cex = equivalent.counterexample.as_ref().unwrap();
    assert_eq!(replay(cex, &set).unwrap(), Decision::Allow, "{cex}");
    assert_eq!(replay(cex, spec()).unwrap(), Decision::Deny, "{cex}");
    assert_eq!(replay(cex, policies()).unwrap(), Decision::Deny, "{cex}");
    let total = cex["context"]["total_minor"].as_i64().unwrap();
    let max = resource_attr(cex, "max_total_minor").as_i64().unwrap();
    assert!(total > max, "{cex}");
}

#[test]
fn extra_permit_without_the_agent_forbid_lets_another_agent_in() {
    let set = SeedBug::ExtraPermit.policy_set();
    assert!(set.policy(&PolicyId::new("agent")).is_none());
    let permits = set
        .policies()
        .filter(|p| p.effect() == Effect::Permit)
        .count();
    assert_eq!(permits, 2);

    let results = prove_set(&solver(), &set).unwrap();
    let equivalent = find(&results, "equivalent", "checkout/policy_set=spec");
    assert_eq!(equivalent.verdict, Verdict::Counterexample);
    let cex = equivalent.counterexample.as_ref().unwrap();
    assert_ne!(
        uid(&cex["principal"]),
        uid(resource_attr(cex, "agent")),
        "{cex}"
    );
    assert_eq!(replay(cex, &set).unwrap(), Decision::Allow, "{cex}");
    assert_eq!(replay(cex, spec()).unwrap(), Decision::Deny, "{cex}");
    assert_eq!(replay(cex, policies()).unwrap(), Decision::Deny, "{cex}");
}

#[test]
fn the_agent_forbid_neutralises_an_extra_permit() {
    let mut set = policies().clone();
    set.add(
        cedar_policy::Policy::parse(
            Some(PolicyId::new("extra")),
            "permit(principal, action, resource);",
        )
        .unwrap(),
    )
    .unwrap();
    let results = prove_set(&solver(), &set).unwrap();
    let equivalent = find(&results, "equivalent", "checkout/policy_set=spec");
    assert_eq!(equivalent.verdict, Verdict::Verified);
}

#[test]
fn seed_bug_flag_prints_counterexamples_and_replays() {
    for (bug, check) in [("overflow", "never_errors"), ("extra-permit", "equivalent")] {
        let out = Command::new(env!("CARGO_BIN_EXE_prove"))
            .args(["--seed-bug", bug])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(1), "{bug}");
        let report: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(report["seed_bug"], bug);
        let found = report["counterexamples"].as_array().unwrap();
        assert!(found.iter().any(|c| c["check"] == check), "{bug}: {report}");
        let equivalent = found
            .iter()
            .find(|c| c["check"] == "equivalent")
            .unwrap_or_else(|| panic!("{bug}: {report}"));
        assert!(equivalent["counterexample"].is_object());
        assert_eq!(equivalent["replay"]["seeded"], "allow", "{bug}");
        assert_eq!(equivalent["replay"]["spec"], "deny", "{bug}");
    }
}

#[test]
fn unknown_seed_bug_is_a_usage_error() {
    let out = Command::new(env!("CARGO_BIN_EXE_prove"))
        .args(["--seed-bug", "nope"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
}
