use std::hint::black_box;
use std::time::Instant;

use alloy_primitives::{B256, U256, address};
use alloy_sol_types::SolStruct;
use keelson_core::domain;
use keelson_policy::{Facts, Reason, VerdictInput, attribute, verdict};

/// `attribute`: one Cedar authorization over the 15 rules and the context built from the facts.
const ATTRIBUTE_BUDGET_US: f64 = 100.0;
/// `verdict` and its EIP-712 signing hash, attribution included.
const VERDICT_BUDGET_US: f64 = 150.0;
const RUNS: usize = 20_000;

/// Prints the p50 and p99 of `f` in microseconds and returns the p99.
fn percentiles<T>(label: &str, mut f: impl FnMut() -> T) -> f64 {
    for _ in 0..RUNS / 10 {
        black_box(f());
    }
    let mut samples: Vec<f64> = (0..RUNS)
        .map(|_| {
            let start = Instant::now();
            black_box(f());
            start.elapsed().as_secs_f64() * 1e6
        })
        .collect();
    samples.sort_by(f64::total_cmp);
    let at = |p: f64| samples[((p * RUNS as f64).ceil() as usize).min(RUNS) - 1];
    println!(
        "{label}: runs={RUNS} p50={:.1}us p99={:.1}us",
        at(0.5),
        at(0.99)
    );
    at(0.99)
}

/// An amber failure, attributed by R61, whose condition negates twelve earlier rules.
fn main() {
    let facts = Facts {
        reason: Reason::Unauthorised,
        proof_valid: true,
        failed_green: false,
        failed_amber: true,
        failed_gray: false,
        captured_eq_countersigned: true,
        duplicate_countersig: false,
        duplicate_capture: false,
        tracking_delivered: false,
        snapshot_matches_item: true,
        refund_recorded: false,
    };
    let input = VerdictInput {
        paypal_dispute_id: "PP-D-27803",
        coverage_id: B256::repeat_byte(0x11),
        agent_id: U256::from(42),
        payee: address!("2222222222222222222222222222222222222222"),
        amount: 125_000_000,
        field_id: 9,
        evidence_hash: B256::repeat_byte(0x33),
        checkpoint_root: B256::repeat_byte(0x66),
        issued_at: 1_794_240_000,
        deadline: 1_794_844_800,
    };
    let domain = domain(
        421_614,
        address!("e16E8767EC1DA59Ef0D9Bc7851637E4D22352d96"),
    )
    .unwrap();
    assert_eq!(attribute(&facts).unwrap().rule, 61);

    let attribute_p99 = percentiles("attribute R61", || attribute(black_box(&facts)));
    let verdict_p99 = percentiles("verdict R61 + EIP-712 digest", || {
        verdict(black_box(&facts), black_box(&input))
            .unwrap()
            .eip712_signing_hash(&domain)
    });
    assert!(
        attribute_p99 < ATTRIBUTE_BUDGET_US,
        "attribute p99 over the {ATTRIBUTE_BUDGET_US}us budget"
    );
    assert!(
        verdict_p99 < VERDICT_BUDGET_US,
        "verdict p99 over the {VERDICT_BUDGET_US}us budget"
    );
}
