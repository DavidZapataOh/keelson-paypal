//! Runs the symcc checks on the policy set and writes the proof bundle as JSON.
//!
//! Usage: `prove [--out <path>]` or `prove --seed-bug overflow|extra-permit`.
//!
//! Without `--seed-bug`, writes the bundle to `--out` or stdout and exits 1 if any check fails.
//! With it, runs the checks on the policy set with that bug seeded and prints each counterexample
//! with its replayed decision under the seeded set and under the spec, exiting 1 if there is any.
//! Each check and its wall time go to stderr. cvc5 is the binary named by `CVC5`, else `cvc5` on
//! `PATH`.

use std::process::ExitCode;

use keelson_policy::{
    Cvc5, ProofResult, SeedBug, Verdict, policies, prove_all, prove_set, replay, spec,
};
use serde_json::{Value, json};

const USAGE: &str = "usage: prove [--out <path>] | prove --seed-bug overflow|extra-permit";

fn main() -> ExitCode {
    let mut out = None;
    let mut seed_bug = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match (arg.as_str(), args.next()) {
            ("--out", Some(path)) => out = Some(path),
            ("--seed-bug", Some(name)) => match SeedBug::parse(&name) {
                Some(bug) => seed_bug = Some(bug),
                None => return usage(),
            },
            _ => return usage(),
        }
    }
    if out.is_some() && seed_bug.is_some() {
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
        Some(bug) => seeded(&solver, bug),
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
    match out {
        Some(path) => {
            if let Err(e) = std::fs::write(&path, json) {
                eprintln!("{path}: {e}");
                return ExitCode::from(2);
            }
        }
        None => print!("{json}"),
    }
    exit(&bundle.results)
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
