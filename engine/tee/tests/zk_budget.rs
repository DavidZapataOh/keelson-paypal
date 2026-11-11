//! The C1 proving budget, timed in a test binary of its own: Cargo runs test binaries one at a
//! time, so no other test's proofs share the CPU with the timed ones. The witness is solved in
//! Rust, so it is timed in the release build the legs run; run with `--release --ignored`.

mod zk_demo;

use std::time::Instant;

use zk_demo::{demo, prover};

/// The budget is 200 ms per proof, witness and `bb` included: 400 ms for one statement's two
/// proofs, EVM and recursive.
#[test]
#[ignore = "times the release build; run with --release"]
fn proving_is_within_budget() {
    let d = demo();
    prover()
        .prove(&d.statement, &d.opening, &d.merchant)
        .unwrap();
    let mut ms: Vec<f64> = (0..20)
        .map(|_| {
            let t = Instant::now();
            prover()
                .prove(&d.statement, &d.opening, &d.merchant)
                .unwrap();
            t.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    ms.sort_by(f64::total_cmp);
    println!("C1 prove: p50 {:.1} ms, max {:.1} ms", ms[10], ms[19]);
    assert!(ms[10] < 400.0, "p50 {:.1} ms", ms[10]);
}
