use std::hint::black_box;
use std::time::Instant;

use criterion::Criterion;
use keelson_mandate::{decode_disclosed, h_sd, mandate_challenge, mandate_commitment};
use serde_json::Value;

const BUDGET_US: f64 = 1000.0;
const RUNS: usize = 20_000;

struct Input {
    payload_sd: Value,
    disclosures: Vec<String>,
}

fn input() -> Input {
    let vectors: Vec<Value> = serde_json::from_str(include_str!(
        "../../../packages/mandate/test/vectors/sd.json"
    ))
    .unwrap();
    let all = vectors.iter().find(|v| v["name"] == "demo/all").unwrap();
    let payload_sd = all["input"]["payloadSd"].clone();
    let disclosures: Vec<String> =
        serde_json::from_value(all["input"]["disclosures"].clone()).unwrap();
    Input {
        payload_sd,
        disclosures,
    }
}

fn derive(i: &Input, salt: [u8; 16]) -> [u8; 32] {
    let m = decode_disclosed(&i.payload_sd, &i.disclosures).unwrap();
    let h = h_sd(&i.payload_sd).unwrap();
    let cm = mandate_commitment(&m, salt).unwrap();
    mandate_challenge(&h, &cm)
}

fn bench(c: &mut Criterion) {
    let i = input();
    c.bench_function("derive demo mandate", |b| {
        b.iter(|| derive(black_box(&i), black_box([7; 16])))
    });
}

fn percentiles(i: &Input) {
    for n in 0..RUNS / 10 {
        black_box(derive(i, [n as u8; 16]));
    }
    let mut samples: Vec<f64> = (0..RUNS)
        .map(|n| {
            let salt = [n as u8; 16];
            let start = Instant::now();
            black_box(derive(i, salt));
            start.elapsed().as_secs_f64() * 1e6
        })
        .collect();
    samples.sort_by(f64::total_cmp);
    let at = |p: f64| samples[((p * RUNS as f64).ceil() as usize).min(RUNS) - 1];
    println!(
        "runs={RUNS} p50={:.1}us p99={:.1}us budget={BUDGET_US}us",
        at(0.5),
        at(0.99)
    );
    assert!(at(0.99) < BUDGET_US, "p99 over budget");
}

fn main() {
    let i = input();
    let mut c = Criterion::default().configure_from_args();
    bench(&mut c);
    c.final_summary();
    percentiles(&i);
}
