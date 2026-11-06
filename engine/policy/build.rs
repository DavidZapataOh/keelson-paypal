//! Exposes the locked versions of the Cedar crates the proofs run on, so the proof bundle names
//! the versions actually built rather than hand-written ones.

use std::path::Path;

fn main() {
    let lock_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.lock");
    println!("cargo:rerun-if-changed={}", lock_path.display());
    let lock = std::fs::read_to_string(&lock_path).expect("the workspace Cargo.lock is readable");
    for (name, var) in [
        ("cedar-policy", "KEELSON_CEDAR_POLICY_VERSION"),
        ("cedar-policy-symcc", "KEELSON_SYMCC_VERSION"),
    ] {
        println!("cargo:rustc-env={var}={}", locked_version(&lock, name));
    }
}

/// The version of the single `[[package]]` entry called `name`.
fn locked_version(lock: &str, name: &str) -> String {
    let name_line = format!("name = \"{name}\"");
    let versions: Vec<_> = lock
        .split("[[package]]")
        .filter(|entry| entry.lines().any(|l| l.trim() == name_line))
        .filter_map(|entry| {
            entry
                .lines()
                .find_map(|l| l.trim().strip_prefix("version = \""))
                .and_then(|v| v.strip_suffix('"'))
        })
        .collect();
    match versions.as_slice() {
        [v] => (*v).to_owned(),
        _ => panic!("Cargo.lock locks {name} at {versions:?}, expected exactly one version"),
    }
}
