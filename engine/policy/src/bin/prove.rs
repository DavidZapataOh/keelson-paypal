//! Runs the symcc checks on the policy set and writes the proof bundle as JSON.
//!
//! Usage: `prove [--attribution] [--out <path>]` or
//! `prove --seed-bug overflow|extra-permit|no-precedence|drop-gray`.
//!
//! Without `--seed-bug`, writes the policy set's bundle, or with `--attribution` the dispute
//! attribution table's, to `--out` or stdout and exits 1 if any check fails. With it, runs the
//! checks with that bug seeded and prints each counterexample replayed under the seeded and the
//! correct policies (for the attribution table, the liable parties each names), exiting 1 if
//! there is any.
//! Each check and its wall time go to stderr. cvc5 is the binary named by `CVC5`, else `cvc5` on
//! `PATH`.

use std::process::ExitCode;

use keelson_policy::{
    AttributionBug, Cvc5, ProofResult, SeedBug, Verdict, attribution_sets, policies, prove_all,
    prove_attribution, prove_attribution_sets, prove_set, replay, replay_attribution, spec,
};
use serde_json::{Value, json};

const USAGE: &str = "usage: prove [--attribution] [--out <path>] | prove --seed-bug overflow|extra-permit|no-precedence|drop-gray";

enum Seeded {
    Policy(SeedBug),
    Attribution(AttributionBug),
}

fn main() -> ExitCode {
    let mut out = None;
    let mut seed_bug = None;
    let mut attribution = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--attribution" {
            attribution = true;
            continue;
        }
        match (arg.as_str(), args.next()) {
            ("--out", Some(path)) => out = Some(path),
            ("--seed-bug", Some(name)) => {
                seed_bug = match (SeedBug::parse(&name), AttributionBug::parse(&name)) {
                    (Some(bug), _) => Some(Seeded::Policy(bug)),
                    (_, Some(bug)) => Some(Seeded::Attribution(bug)),
                    _ => return usage(),
                }
            }
            _ => return usage(),
        }
    }
    if seed_bug.is_some() && (out.is_some() || attribution) {
        return usage();
    }

    let solver = match Cvc5::from_env() {
        Ok(solver) => solver,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    match seed_bug {
        Some(Seeded::Policy(bug)) => seeded(&solver, bug),
        Some(Seeded::Attribution(bug)) => seeded_attribution(&solver, bug),
        None if attribution => attribution_bundle(&solver, out),
        None => bundle(&solver, out),
    }
}

fn usage() -> ExitCode {
    eprintln!("{USAGE}");
    ExitCode::from(2)
}

fn log(results: &[ProofResult]) {
    for r in results {
        eprintln!(
            "{:<18} {:<35} {:?} {:>8.3} ms",
            r.check,
            r.subject,
            r.verdict,
            r.elapsed.as_secs_f64() * 1e3
        );
    }
}

fn exit(results: &[ProofResult]) -> ExitCode {
    if results.iter().all(|r| r.verdict == Verdict::Verified) {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn bundle(solver: &Cvc5, out: Option<String>) -> ExitCode {
    let bundle = match prove_all(solver) {
        Ok(bundle) => bundle,
        Err(e) => {
            eprintln!("symcc: {e}");
            return ExitCode::from(2);
        }
    };
    log(&bundle.results);
    let json = serde_json::to_string_pretty(&bundle).expect("the bundle serializes") + "\n";
    write(out, &json, &bundle.results)
}

fn attribution_bundle(solver: &Cvc5, out: Option<String>) -> ExitCode {
    let bundle = match prove_attribution(solver) {
        Ok(bundle) => bundle,
        Err(e) => {
            eprintln!("symcc: {e}");
            return ExitCode::from(2);
        }
    };
    log(&bundle.results);
    let json = serde_json::to_string_pretty(&bundle).expect("the bundle serializes") + "\n";
    write(out, &json, &bundle.results)
}

fn write(out: Option<String>, json: &str, results: &[ProofResult]) -> ExitCode {
    match out {
        Some(path) => {
            if let Err(e) = std::fs::write(&path, json) {
                eprintln!("{path}: {e}");
                return ExitCode::from(2);
            }
        }
        None => print!("{json}"),
    }
    exit(results)
}

fn seeded(solver: &Cvc5, bug: SeedBug) -> ExitCode {
    let set = bug.policy_set();
    let results = match prove_set(solver, &set) {
        Ok(results) => results,
        Err(e) => {
            eprintln!("symcc: {e}");
            return ExitCode::from(2);
        }
    };
    log(&results);
    let mut found = Vec::new();
    for r in &results {
        let Some(cex) = &r.counterexample else {
            continue;
        };
        let decide = |set| match replay(cex, set) {
            Ok(decision) => json!(decision),
            Err(e) => Value::String(format!("error: {e}")),
        };
        found.push(json!({
            "check": r.check,
            "subject": r.subject,
            "counterexample": cex,
            "replay": { "seeded": decide(&set), "policy_set": decide(policies()), "spec": decide(spec()) },
        }));
    }
    let report = json!({ "seed_bug": bug.name(), "counterexamples": found });
    println!(
        "{}",
        serde_json::to_string_pretty(&report).expect("the report serializes")
    );
    exit(&results)
}

fn seeded_attribution(solver: &Cvc5, bug: AttributionBug) -> ExitCode {
    let sets = bug.sets();
    let results = match prove_attribution_sets(solver, &sets) {
        Ok(results) => results,
        Err(e) => {
            eprintln!("symcc: {e}");
            return ExitCode::from(2);
        }
    };
    log(&results);
    let mut found = Vec::new();
    for r in &results {
        let Some(cex) = &r.counterexample else {
            continue;
        };
        let liable = |sets| match replay_attribution(cex, sets) {
            Ok(parties) => json!(parties),
            Err(e) => Value::String(format!("error: {e}")),
        };
        found.push(json!({
            "check": r.check,
            "subject": r.subject,
            "counterexample": cex,
            "replay": { "seeded": liable(&sets), "rules": liable(attribution_sets()) },
        }));
    }
    let report = json!({ "seed_bug": bug.name(), "counterexamples": found });
    println!(
        "{}",
        serde_json::to_string_pretty(&report).expect("the report serializes")
    );
    exit(&results)
}
