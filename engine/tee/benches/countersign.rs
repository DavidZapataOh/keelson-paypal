#[path = "../tests/common/mod.rs"]
mod common;

use std::hint::black_box;
use std::time::Instant;

use criterion::{BatchSize, Criterion};
use keelson_tee::Engine;
use keelson_tee::wire::{CountersignRequest, MandateIssued};

use common::*;

/// Full countersign of the demo cart: closed-mandate and passkey verification, canonicalization,
/// Cedar, EIP-712 signing and, on leg A, the reservation.
const COUNTERSIGN_BUDGET_US: f64 = 2_000.0;
/// Registering the demo mandate, which issues the user credential and the open mandate.
const REGISTER_BUDGET_US: f64 = 5_000.0;
const RUNS: usize = 5_000;
const CLOCK: i64 = NOW + 10;

/// Leg B's request for the demo cart under request id `n`, closed by the agent.
fn leg_b_request(issued: &MandateIssued, f: &CartFixture, n: u128) -> CountersignRequest {
    let id = request_id(n);
    let mut r = countersign_request(issued, f, id, Some(observation(CLOCK * 1000)));
    r.closed_mandate = close(&issued.open_mandate, &id.to_string(), &f.hash(), CLOCK);
    r
}

fn allows(engine: &Engine, r: &CountersignRequest) -> bool {
    engine
        .countersign(r, at(CLOCK))
        .unwrap()
        .countersign
        .decision
        == "1"
}

fn bench(c: &mut Criterion, issued: &MandateIssued, f: &CartFixture) {
    // Leg A reserves the demo amount, so each run gets a fresh engine with the full budget.
    let a = countersign_request(issued, f, request_id(1), None);
    c.bench_function("countersign demo ALLOW, leg A", |b| {
        b.iter_batched_ref(
            leg_a,
            |engine| engine.countersign(black_box(&a), at(CLOCK)),
            BatchSize::SmallInput,
        )
    });
    // Each run gets a fresh leg B too, so its request ledger never reaches the live-request cap.
    let mut n = 1_000_000;
    c.bench_function("countersign demo ALLOW, leg B", |b| {
        b.iter_batched_ref(
            || {
                n += 1;
                (leg_b(), leg_b_request(issued, f, n))
            },
            |(engine, r)| engine.countersign(black_box(r), at(CLOCK)),
            BatchSize::SmallInput,
        )
    });
    let engine = leg_a();
    let r = register_request();
    c.bench_function("register_mandate demo", |b| {
        b.iter(|| engine.register_mandate(black_box(&r), at(NOW)))
    });
}

/// Prints the p50 and p99 of `f` over inputs from `setup` in microseconds, dropping its output
/// included, and returns the p99. Setup is not timed.
fn percentiles<I, T>(label: &str, mut setup: impl FnMut() -> I, mut f: impl FnMut(&I) -> T) -> f64 {
    for _ in 0..RUNS / 10 {
        black_box(f(&setup()));
    }
    let mut samples: Vec<f64> = (0..RUNS)
        .map(|_| {
            let input = setup();
            let start = Instant::now();
            black_box(f(&input));
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

/// Budgets (p99, host, mains power): countersign < [`COUNTERSIGN_BUDGET_US`] on either leg,
/// `register_mandate` < [`REGISTER_BUDGET_US`].
fn main() {
    let issued = register();
    let f = CartFixture::demo();
    assert!(allows(
        &leg_a(),
        &countersign_request(&issued, &f, request_id(1), None)
    ));
    assert!(allows(&leg_b(), &leg_b_request(&issued, &f, 1)));

    let mut c = Criterion::default().configure_from_args();
    bench(&mut c, &issued, &f);
    c.final_summary();

    let a = countersign_request(&issued, &f, request_id(1), None);
    let leg_a_p99 = percentiles("countersign demo ALLOW, leg A", leg_a, |engine| {
        engine.countersign(black_box(&a), at(CLOCK))
    });
    let mut n = 2_000_000;
    let leg_b_p99 = percentiles(
        "countersign demo ALLOW, leg B",
        || {
            n += 1;
            (leg_b(), leg_b_request(&issued, &f, n))
        },
        |(engine, r)| engine.countersign(black_box(r), at(CLOCK)),
    );
    assert!(allows(&leg_b(), &leg_b_request(&issued, &f, n + 1)));
    let engine = leg_a();
    let r = register_request();
    let register_p99 = percentiles(
        "register_mandate demo",
        || (),
        |()| engine.register_mandate(black_box(&r), at(NOW)),
    );
    assert!(engine.register_mandate(&r, at(NOW)).is_ok());

    for (name, p99, budget) in [
        ("countersign leg A", leg_a_p99, COUNTERSIGN_BUDGET_US),
        ("countersign leg B", leg_b_p99, COUNTERSIGN_BUDGET_US),
        ("register_mandate", register_p99, REGISTER_BUDGET_US),
    ] {
        assert!(p99 < budget, "{name} p99 over the {budget}us budget");
    }
}
