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
    let mut ms: Vec<f64> = (0..40)
        .map(|_| {
            let t = Instant::now();
            prover()
                .prove(&d.statement, &d.opening, &d.merchant)
                .unwrap();
            t.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    ms.sort_by(f64::total_cmp);
    let (p50, p95, max) = (ms[19], ms[37], ms[39]);
    println!("C1 prove: p50 {p50:.1} ms, p95 {p95:.1} ms, max {max:.1} ms");
    assert!(p50 < 400.0, "p50 {p50:.1} ms");
}

#[test]
#[ignore = "lever measurement"]
fn levers() {
    let d = demo();
    let bb = std::env::var("KEELSON_BB").unwrap();
    let stat = |mut ms: Vec<f64>| {
        ms.sort_by(f64::total_cmp);
        format!(
            "p50 {:.1} ms, p95 {:.1} ms, max {:.1} ms",
            ms[19], ms[37], ms[39]
        )
    };
    for threads in [None, Some("1"), Some("2"), Some("4")] {
        unsafe {
            match threads {
                Some(t) => std::env::set_var("HARDWARE_CONCURRENCY", t),
                None => std::env::remove_var("HARDWARE_CONCURRENCY"),
            }
        }
        let p = keelson_tee::zk::Prover::spawn(bb.as_ref()).unwrap();
        p.prove(&d.statement, &d.opening, &d.merchant).unwrap();
        let time = |f: &dyn Fn()| {
            (0..40)
                .map(|_| {
                    let t = Instant::now();
                    f();
                    t.elapsed().as_secs_f64() * 1e3
                })
                .collect::<Vec<_>>()
        };
        let par = time(&|| {
            p.prove(&d.statement, &d.opening, &d.merchant).unwrap();
        });
        let seq = time(&|| {
            p.prove_sequential(&d.statement, &d.opening, &d.merchant)
                .unwrap();
        });
        println!("lever threads={threads:?} parallel: {}", stat(par));
        println!("lever threads={threads:?} sequential: {}", stat(seq));
    }
}
