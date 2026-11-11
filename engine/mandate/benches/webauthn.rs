use std::hint::black_box;
use std::time::Instant;

use criterion::Criterion;
use keelson_core::AcirField;
use keelson_mandate::{
    Assertion, Expected, Fr, decode_mandate, h_sd, mandate_challenge, spc_details, verify_assertion,
};
use serde_json::Value;

const BUDGET_US: f64 = 200.0;
const RUNS: usize = 20_000;

fn input(name: &str) -> (Assertion, Expected) {
    let vectors: Vec<Value> = serde_json::from_str(include_str!(
        "../../../packages/mandate/test/vectors/webauthn.json"
    ))
    .unwrap();
    let i = &vectors.iter().find(|v| v["name"] == name).unwrap()["input"];
    let text = |v: &Value| v.as_str().unwrap().to_owned();
    let disclosures: Vec<String> = serde_json::from_value(i["disclosures"].clone()).unwrap();
    let m = decode_mandate(&i["payloadSd"], &disclosures).unwrap();
    let cm = Fr::from_hex(i["cm"].as_str().unwrap()).unwrap();
    let sec1 = i["publicKeySec1"]
        .as_str()
        .unwrap()
        .strip_prefix("0x")
        .unwrap();
    let a = &i["assertion"];
    (
        Assertion {
            authenticator_data: text(&a["authenticatorData"]),
            client_data_json: text(&a["clientDataJSON"]),
            signature: text(&a["signature"]),
        },
        Expected {
            challenge: mandate_challenge(&h_sd(&i["payloadSd"]).unwrap(), &cm),
            origin: text(&i["origin"]),
            top_origin: i["topOrigin"].as_str().map(str::to_owned),
            rp_id: text(&i["rpId"]),
            public_key_sec1: (0..sec1.len())
                .step_by(2)
                .map(|k| u8::from_str_radix(&sec1[k..k + 2], 16).unwrap())
                .collect(),
            spc: spc_details(&m).unwrap(),
        },
    )
}

fn percentiles(a: &Assertion, e: &Expected) {
    for _ in 0..RUNS / 10 {
        black_box(verify_assertion(black_box(a), black_box(e))).unwrap();
    }
    let mut samples: Vec<f64> = (0..RUNS)
        .map(|_| {
            let start = Instant::now();
            black_box(verify_assertion(black_box(a), black_box(e))).unwrap();
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
    let (a, e) = input("verify/ok/payment.get");
    let mut c = Criterion::default().configure_from_args();
    c.bench_function("verify payment.get assertion", |b| {
        b.iter(|| verify_assertion(black_box(&a), black_box(&e)))
    });
    c.final_summary();
    percentiles(&a, &e);
}
