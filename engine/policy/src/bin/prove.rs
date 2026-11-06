//! Runs the symcc checks on the policy set and writes the proof bundle as JSON.
//!
//! Usage: `prove [--out <path>]`. Writes to stdout without `--out`, prints each check and its
//! wall time to stderr, and exits 1 if any check fails.
//!
//! cvc5 is the binary named by `CVC5`, else `cvc5` on `PATH`.

use std::process::ExitCode;

use keelson_policy::{Cvc5, Verdict, prove_all};

fn main() -> ExitCode {
    let mut out = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match (arg.as_str(), args.next()) {
            ("--out", Some(path)) => out = Some(path),
            _ => {
                eprintln!("usage: prove [--out <path>]");
                return ExitCode::from(2);
            }
        }
    }

    let solver = match Cvc5::from_env() {
        Ok(solver) => solver,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let bundle = match prove_all(&solver) {
        Ok(bundle) => bundle,
        Err(e) => {
            eprintln!("symcc: {e}");
            return ExitCode::from(2);
        }
    };

    for r in &bundle.results {
        eprintln!(
            "{:<18} {:<26} {:?} {:>8.3} ms",
            r.check,
            r.subject,
            r.verdict,
            r.elapsed.as_secs_f64() * 1e3
        );
    }
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

    if bundle
        .results
        .iter()
        .all(|r| r.verdict == Verdict::Verified)
    {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
