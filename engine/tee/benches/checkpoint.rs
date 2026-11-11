#[path = "../tests/common/mod.rs"]
mod common;

use std::hint::black_box;
use std::time::Instant;

use keelson_tee::wire::CheckpointRequest;

use common::*;

/// Verifying a witnessed sandbox checkpoint (log signature and two cosignatures) and signing its
/// EIP-712 `Checkpoint`.
const CHECKPOINT_BUDGET_US: f64 = 1_000.0;
const RUNS: usize = 5_000;
/// After every cosignature of the note.
const CLOCK: i64 = 1_794_500_000;

/// Budget (p99, host, mains power): `sign_checkpoint` < [`CHECKPOINT_BUDGET_US`].
fn main() {
    let engine = leg_b();
    let r = CheckpointRequest {
        signed_note: include_str!("../tests/data/checkpoints/alibi-2026-1-823.note").into(),
        chain_id: None,
    };
    assert!(engine.sign_checkpoint(&r, at(CLOCK)).is_ok());
    for _ in 0..RUNS / 10 {
        black_box(engine.sign_checkpoint(black_box(&r), at(CLOCK)).unwrap());
    }
    let mut samples: Vec<f64> = (0..RUNS)
        .map(|_| {
            let start = Instant::now();
            black_box(engine.sign_checkpoint(black_box(&r), at(CLOCK)).unwrap());
            start.elapsed().as_secs_f64() * 1e6
        })
        .collect();
    samples.sort_by(f64::total_cmp);
    let at = |p: f64| samples[((p * RUNS as f64).ceil() as usize).min(RUNS) - 1];
    println!(
        "sign_checkpoint sandbox: runs={RUNS} p50={:.1}us p99={:.1}us",
        at(0.5),
        at(0.99)
    );
    assert!(
        at(0.99) < CHECKPOINT_BUDGET_US,
        "sign_checkpoint p99 over the budget"
    );
}
