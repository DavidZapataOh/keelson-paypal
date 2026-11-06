use std::hint::black_box;
use std::time::Instant;

use criterion::Criterion;
use keelson_canon::{Cart, PayPalUnit, canonicalize};
use serde::Deserialize;
use serde_json::{Value, json};

const BUDGET_US: f64 = 5.0;
const RUNS: usize = 200_000;
const COLORS: [&str; 4] = ["black", "white", "navy", "red"];

#[derive(Deserialize)]
struct Input {
    cart: Cart,
    unit: PayPalUnit,
}

fn money(minor: i64) -> String {
    format!("{}.{:02}", minor / 100, minor % 100)
}

fn amount(minor: i64) -> Value {
    json!({ "currency_code": "USD", "value": money(minor) })
}

fn demo() -> Input {
    serde_json::from_str(include_str!("../tests/fixtures/demo-shoes.json")).unwrap()
}

fn sixteen_lines() -> Input {
    let lines: Vec<Value> = (0..16)
        .map(|i| {
            json!({
                "sku": format!("SKU-{i:03}"),
                "size": format!("{}", 6 + i % 8),
                "color": COLORS[i % 4],
                "category": format!("gpt:{}", 187 + i % 5),
                "qty": 1 + i % 3,
                "unit_minor": 1000 + 137 * i,
            })
        })
        .collect();
    let items: i64 = lines
        .iter()
        .map(|l| l["qty"].as_i64().unwrap() * l["unit_minor"].as_i64().unwrap())
        .sum();
    let total = items + 500 + 799 + 100 + 50 - 300 - 200;
    serde_json::from_value(json!({
        "cart": {
            "merchant": "mrc_runfast",
            "currency": "USD",
            "return_days": 30,
            "returns_free": true,
            "lines": lines,
        },
        "unit": {
            "amount": {
                "currency_code": "USD",
                "value": money(total),
                "breakdown": {
                    "item_total": amount(items),
                    "tax_total": amount(500),
                    "shipping": amount(799),
                    "handling": amount(100),
                    "insurance": amount(50),
                    "discount": amount(300),
                    "shipping_discount": amount(200),
                },
            },
        },
    }))
    .unwrap()
}

fn bench(c: &mut Criterion, name: &str, i: &Input) {
    c.bench_function(name, |b| {
        b.iter(|| canonicalize(black_box(&i.cart), black_box(&i.unit)).unwrap())
    });
}

fn percentiles(name: &str, i: &Input) {
    for _ in 0..RUNS / 10 {
        black_box(canonicalize(black_box(&i.cart), black_box(&i.unit)).unwrap());
    }
    let mut samples: Vec<f64> = (0..RUNS)
        .map(|_| {
            let start = Instant::now();
            black_box(canonicalize(black_box(&i.cart), black_box(&i.unit)).unwrap());
            start.elapsed().as_secs_f64() * 1e6
        })
        .collect();
    samples.sort_by(f64::total_cmp);
    let at = |p: f64| samples[((p * RUNS as f64).ceil() as usize).min(RUNS) - 1];
    println!(
        "{name}: runs={RUNS} p50={:.2}us p99={:.2}us budget={BUDGET_US}us",
        at(0.5),
        at(0.99)
    );
    assert!(at(0.99) < BUDGET_US, "{name}: p99 over budget");
}

fn main() {
    let carts = [("demo cart", demo()), ("16-line cart", sixteen_lines())];
    let mut c = Criterion::default().configure_from_args();
    for (name, i) in &carts {
        bench(&mut c, &format!("canonicalize {name}"), i);
    }
    c.final_summary();
    for (name, i) in &carts {
        percentiles(name, i);
    }
}
