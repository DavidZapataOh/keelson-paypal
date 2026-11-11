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

fn stats(mut ms: Vec<f64>) -> String {
    ms.sort_by(f64::total_cmp);
    let n = ms.len();
    format!(
        "p50 {:.1} ms, p95 {:.1} ms, max {:.1} ms",
        ms[n / 2],
        ms[(n * 95).div_ceil(100) - 1],
        ms[n - 1]
    )
}

/// Experiment: each lever alone, on fresh `bb` processes.
#[test]
#[ignore = "experiment"]
fn levers() {
    let d = demo();
    let bb = std::env::var("KEELSON_BB").unwrap();
    for (parallel, threads) in [
        (false, None),
        (false, Some(1)),
        (false, Some(2)),
        (false, Some(4)),
        (true, None),
        (true, Some(1)),
        (true, Some(2)),
        (false, None),
    ] {
        let p = keelson_tee::zk::Prover::spawn_with(bb.as_ref(), parallel, threads).unwrap();
        p.prove(&d.statement, &d.opening, &d.merchant).unwrap();
        let ms = (0..30)
            .map(|_| {
                let t = Instant::now();
                p.prove(&d.statement, &d.opening, &d.merchant).unwrap();
                t.elapsed().as_secs_f64() * 1e3
            })
            .collect();
        println!(
            "lever parallel={parallel} threads={threads:?}: {}",
            stats(ms)
        );
        if !parallel && threads.is_none() {
            p.compute_vks().unwrap();
            let ms = (0..10)
                .map(|_| {
                    let t = Instant::now();
                    p.compute_vks().unwrap();
                    t.elapsed().as_secs_f64() * 1e3
                })
                .collect();
            println!(
                "lever compute both vks (circuit + proving key, no proof): {}",
                stats(ms)
            );
        }
    }
}
