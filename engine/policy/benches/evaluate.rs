use std::collections::BTreeMap;
use std::hint::black_box;
use std::time::Instant;

use criterion::Criterion;
use keelson_canon::{Cart, PayPalUnit, canonicalize};
use keelson_policy::{
    Decision, EngineMeta, EvalInput, Extra, evaluate, evaluate_with_extras, mandate_agent,
    trace_jcs,
};
use serde_json::Value;
use time::Duration;
use time::macros::datetime;

const EVALUATE_BUDGET_US: f64 = 20.0;
const TRACE_JCS_BUDGET_US: f64 = 15.0;
const RUNS: usize = 20_000;

fn input() -> EvalInput {
    let mandate: Value = serde_json::from_str(include_str!(
        "../../../packages/mandate/test/fixtures/demo-mandate.json"
    ))
    .unwrap();
    let fixture: Value =
        serde_json::from_str(include_str!("../../canon/tests/fixtures/demo-shoes.json")).unwrap();
    let cart: Cart = serde_json::from_value(fixture["cart"].clone()).unwrap();
    let unit: PayPalUnit = serde_json::from_value(fixture["unit"].clone()).unwrap();
    EvalInput {
        agent: mandate_agent(&mandate).unwrap(),
        mandate,
        budget_left_minor: 10_000,
        context: canonicalize(&cart, &unit).unwrap(),
        now: datetime!(2026-11-05 17:02:11.250 UTC),
        evidence: BTreeMap::from([(
            "total".to_owned(),
            vec!["paypal.authorization.amount".to_owned()],
        )]),
        mandate_hash: [0x11; 32],
        cart_hash: [0x22; 32],
    }
}

fn meta() -> EngineMeta {
    let h = |c: &str| format!("sha256:{}", c.repeat(64));
    EngineMeta::new("0.8.1", "1.3.1", &h("a"), &h("b"), &h("c"))
}

fn extras() -> Vec<Extra> {
    vec![
        Extra::MaxUnitPrice { minor: 50_000 },
        Extra::DenyMerchant {
            id: "mrc_banned".to_owned(),
        },
        Extra::DenyCategory {
            id: "gpt:187".to_owned(),
        },
    ]
}

fn tick(i: &mut EvalInput) -> &EvalInput {
    i.now += Duration::milliseconds(1);
    i
}

fn bench(c: &mut Criterion) {
    let (i, m, e) = (input(), meta(), extras());
    let trace = evaluate(&i, &m);
    let mut clock = i.clone();
    c.bench_function("evaluate demo", |b| {
        b.iter(|| evaluate(black_box(tick(&mut clock)), black_box(&m)))
    });
    c.bench_function("trace_jcs demo", |b| {
        b.iter(|| trace_jcs(black_box(&trace)))
    });
    c.bench_function("evaluate demo with 3 extras", |b| {
        b.iter(|| evaluate_with_extras(black_box(tick(&mut clock)), black_box(&e), black_box(&m)))
    });
    assert!(
        evaluate(&clock, &m).decision == Decision::Allow,
        "the clock stays within the window"
    );
}

/// Prints the p50 and p99 of `f` in microseconds, dropping its output included, and returns the
/// p99.
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

/// Every evaluation sees the clock a millisecond later than the one before, as in production.
fn main() {
    let (i, m, e) = (input(), meta(), extras());
    assert!(
        evaluate(&i, &m).decision == Decision::Allow,
        "demo input must allow"
    );
    let mut c = Criterion::default().configure_from_args();
    bench(&mut c);
    c.final_summary();
    let trace = evaluate(&i, &m);
    let mut clock = i.clone();
    let evaluate_p99 = percentiles("evaluate demo", || {
        evaluate(black_box(tick(&mut clock)), black_box(&m))
    });
    let trace_jcs_p99 = percentiles("trace_jcs demo", || trace_jcs(black_box(&trace)));
    percentiles("evaluate demo with 3 extras", || {
        evaluate_with_extras(black_box(tick(&mut clock)), black_box(&e), black_box(&m))
    });
    assert!(
        evaluate(&clock, &m).decision == Decision::Allow,
        "the clock stays within the window"
    );
    assert!(
        evaluate_p99 < EVALUATE_BUDGET_US,
        "evaluate p99 over the {EVALUATE_BUDGET_US}us budget"
    );
    assert!(
        trace_jcs_p99 < TRACE_JCS_BUDGET_US,
        "trace_jcs p99 over the {TRACE_JCS_BUDGET_US}us budget"
    );
}
