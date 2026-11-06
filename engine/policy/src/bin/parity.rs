//! Writes seeded evaluation cases as JSONL, one `{ input, trace_jcs_hex }` per line, so another
//! implementation of the evaluator can check that it emits byte-identical traces.
//!
//! Usage: `parity --seed <u64> --n <usize>`.
//!
//! The generator covers allowed carts, every `forbid`, ill-formed mandates, raw contexts with
//! missing, ill-typed or extra attributes, inconsistent quantities, the edges of the purchase
//! window, and valid, invalid and too many extras.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufWriter, Write};

use keelson_canon::{Context, Variant};
use keelson_mandate::CATEGORY_IDS;
use keelson_policy::{
    EngineMeta, EvalInput, Extra, MAX_EXTRAS, evaluate_context_with_extras, evaluate_with_extras,
    mandate_agent, trace_jcs,
};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// SplitMix64: small, seedable and the same on every platform.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + self.below((hi - lo + 1) as u64) as i64
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }

    fn subset<T: Clone>(&mut self, items: &[T], min: usize, max: usize) -> Vec<T> {
        let mut pool = items.to_vec();
        let n = min + self.below((max.min(items.len()) - min + 1) as u64) as usize;
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            out.push(pool.remove(self.below(pool.len() as u64) as usize));
        }
        out
    }

    fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            items.swap(i, self.below(i as u64 + 1) as usize);
        }
    }
}

const REGISTRIES: [&str; 3] = [
    "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    "eip155:1:0x00000000000000000000000000000000000000aa",
    "registry/with/slashes",
];
const AGENT_IDS: [&str; 4] = ["0", "42", "7", "123456789"];
const MERCHANTS: [&str; 7] = [
    "mrc_runfast",
    "mrc_trailco",
    "mrc_Zeta",
    "mrc_émile",
    "mrc_\u{ff5e}wave",
    "mrc_😀smile",
    "mrc_shoe hub",
];
const SKUS: [&str; 6] = [
    "sku-trail-10",
    "sku-road-9",
    "sku-B",
    "sku-a",
    "sku-ü",
    "sku-😀",
];
const SIZES: [&str; 4] = ["9", "10", "10.5", "any"];
const COLORS: [&str; 4] = ["red", "blue", "Grün", "any"];
const CURRENCIES: [&str; 3] = ["USD", "EUR", "JPY"];
const EVIDENCE: [&str; 5] = [
    "paypal.authorization.amount",
    "ucp:merchant-signature",
    "zktls:proof",
    "cart.lines",
    "ucpx:not-a-proof",
];
const FIELDS: [&str; 10] = [
    "agent",
    "cart",
    "currency",
    "total",
    "budget",
    "merchant",
    "deadline",
    "category",
    "variant",
    "return_policy",
];

/// The window the mandates are issued in: 2026-11-03T00:00:00Z plus up to a day.
const BASE_NBF: i64 = 1_793_750_400;

/// What a case exercises. Each case index picks one in turn, so every scenario appears in even
/// small samples.
#[derive(Clone, Copy)]
enum Scenario {
    Allow,
    Forbid(&'static str),
    BadMandate,
    RawContext,
    Quantities,
    WindowEdge,
    Extras,
    BadExtras,
    TooManyExtras,
}

const SCENARIOS: [Scenario; 21] = [
    Scenario::Allow,
    Scenario::Allow,
    Scenario::Forbid("agent"),
    Scenario::Forbid("sanity"),
    Scenario::Forbid("currency"),
    Scenario::Forbid("amount"),
    Scenario::Forbid("budget"),
    Scenario::Forbid("merchant"),
    Scenario::Forbid("window"),
    Scenario::Forbid("quantity"),
    Scenario::Forbid("category"),
    Scenario::Forbid("variant"),
    Scenario::Forbid("returns"),
    Scenario::Forbid("returns_free"),
    Scenario::BadMandate,
    Scenario::RawContext,
    Scenario::Quantities,
    Scenario::WindowEdge,
    Scenario::Extras,
    Scenario::BadExtras,
    Scenario::TooManyExtras,
];

/// One generated case: the evaluator inputs, plus a raw context to replay in place of the
/// projection of `input.context`.
struct Case {
    input: EvalInput,
    raw_context: Option<Value>,
    extras: Vec<Extra>,
}

/// The parts of a generated mandate the cart generator reads back.
struct Shape {
    currency: String,
    max_total: i64,
    budget_max: i64,
    merchants: Vec<String>,
    skus: Vec<String>,
    max_qty: i64,
    categories: Vec<String>,
    size: Option<String>,
    color: Option<String>,
    min_return_days: i64,
    returns_free: bool,
    nbf_ms: i64,
    expires_ms: i64,
}

fn rfc3339(ms: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .expect("in range")
        .format(&Rfc3339)
        .expect("formats")
}

/// A `not_after` in one of the forms RFC 3339 allows, and its instant in milliseconds.
fn not_after(r: &mut Rng, nbf: i64) -> (String, i64) {
    let s = not_after_text(r, nbf);
    let t = OffsetDateTime::parse(&s, &Rfc3339).expect("a valid RFC 3339 instant");
    let ms = t.unix_timestamp_nanos().div_euclid(1_000_000);
    (s, i64::try_from(ms).unwrap())
}

fn not_after_text(r: &mut Rng, nbf: i64) -> String {
    let secs = nbf + r.range(3_600, 40 * 86_400);
    match r.below(6) {
        0 => rfc3339(secs * 1000),
        1 => {
            let ms = secs * 1000 + r.range(1, 999);
            let t = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000).unwrap();
            format!(
                "{:04}-{:02}-{:02}t{:02}:{:02}:{:02}.{:03}987654z",
                t.year(),
                u8::from(t.month()),
                t.day(),
                t.hour(),
                t.minute(),
                t.second(),
                t.millisecond()
            )
        }
        2 => {
            let t = OffsetDateTime::from_unix_timestamp(secs).unwrap();
            format!(
                "{:04}-{:02}-{:02} {:02}:{:02}:{:02}+05:30",
                t.year(),
                u8::from(t.month()),
                t.day(),
                t.hour(),
                t.minute(),
                t.second()
            )
        }
        3 => {
            let t = OffsetDateTime::from_unix_timestamp(secs).unwrap();
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.5-08:00",
                t.year(),
                u8::from(t.month()),
                t.day(),
                t.hour(),
                t.minute(),
                t.second()
            )
        }
        // A leap second at the end of a month UTC.
        4 => "2026-11-30T23:59:60Z".to_owned(),
        _ => "2026-12-31T23:59:59.9999Z".to_owned(),
    }
}

fn mandate(r: &mut Rng) -> (Value, Shape) {
    let currency = r.pick(&CURRENCIES).to_string();
    let max_total = r.range(5_000, 20_000);
    let budget_max = r.range(5_000, 20_000);
    let merchants: Vec<String> = r
        .subset(&MERCHANTS, 1, 3)
        .into_iter()
        .map(str::to_owned)
        .collect();

    let mut lines = Vec::new();
    let mut skus = Vec::new();
    let mut max_qty = i64::MAX;
    for n in 0..r.range(1, 3) {
        let items: Vec<&str> = r.subset(&SKUS, 1, 3);
        let qty = r.range(1, 4);
        max_qty = max_qty.min(qty);
        skus.extend(items.iter().map(|s| s.to_string()));
        lines.push(json!({
            "id": format!("l{n}"),
            "acceptable_items": items.iter().map(|id| json!({ "id": id, "title": "Shoe" })).collect::<Vec<_>>(),
            "quantity": qty,
        }));
    }
    skus.sort();
    skus.dedup();

    let mut checkout = vec![
        json!({
            "type": "checkout.allowed_merchants",
            "allowed": merchants.iter().map(|id| json!({
                "id": id, "name": "Shop", "website": "https://shop.example", "paypal_merchant_id": "MERCH1"
            })).collect::<Vec<_>>(),
        }),
        json!({ "type": "checkout.line_items", "items": lines }),
    ];

    let mut categories: Vec<String> = CATEGORY_IDS.iter().map(|c| c.to_string()).collect();
    if r.chance(75) {
        let allow = r.subset(&CATEGORY_IDS, 1, 4);
        let deny: Vec<&str> = if r.chance(30) {
            vec![*r.pick(&allow)]
        } else if r.chance(20) {
            vec![*r.pick(&CATEGORY_IDS)]
        } else {
            vec![]
        };
        categories = allow
            .iter()
            .filter(|c| !deny.contains(c))
            .map(|c| c.to_string())
            .collect();
        checkout.push(json!({ "type": "keelson.category", "allow": allow, "deny": deny }));
    }

    let (mut size, mut color) = (None, None);
    if r.chance(65) {
        let mut must = Vec::new();
        if r.chance(80) {
            let s = r.pick(&SIZES).to_string();
            size = (s != "any").then(|| s.clone());
            must.push(("size_us", s));
        }
        if r.chance(60) {
            let c = r.pick(&COLORS).to_string();
            color = (c != "any").then(|| c.clone());
            must.push(("color", c));
        }
        r.shuffle(&mut must);
        let must: serde_json::Map<_, _> = must
            .into_iter()
            .map(|(k, v)| (k.to_owned(), Value::String(v)))
            .collect();
        checkout.push(json!({ "type": "keelson.attributes", "must": must }));
    }

    let (mut min_return_days, mut returns_free) = (0, false);
    if r.chance(65) {
        min_return_days = r.range(0, 60);
        returns_free = r.chance(50);
        checkout.push(
            json!({ "type": "keelson.returns", "min_days": min_return_days, "free": returns_free }),
        );
    }
    r.shuffle(&mut checkout);

    let nbf = BASE_NBF + r.range(0, 86_400);
    let exp = nbf + r.range(3_600, 30 * 86_400);
    let (not_after, not_after_ms) = not_after(r, nbf);
    let mut payment = vec![
        json!({ "type": "payment.amount_range", "max": max_total, "currency": currency }),
        json!({ "type": "payment.budget", "max": budget_max, "currency": currency }),
        json!({ "type": "payment.allowed_payees", "allowed": [{ "paypal_merchant_id": "MERCH1" }] }),
        json!({ "type": "payment.execution_date", "not_after": not_after }),
    ];
    r.shuffle(&mut payment);

    let m = json!({
        "v": "keelson.mandate.1",
        "mid": format!("01JBXG3K5N7Q9R2T4V6W8Y{:04}", r.below(10_000)),
        "iat": nbf,
        "nbf": nbf,
        "exp": exp,
        "agent": { "operator": {
            "agent_registry": r.pick(&REGISTRIES),
            "agent_id": r.pick(&AGENT_IDS),
        } },
        "payment": { "rail": "paypal", "currency": currency, "constraints": payment },
        "checkout": { "constraints": checkout },
    });
    let shape = Shape {
        currency,
        max_total,
        budget_max,
        merchants,
        skus,
        max_qty,
        categories,
        size,
        color,
        min_return_days,
        returns_free,
        nbf_ms: nbf * 1000,
        expires_ms: (exp * 1000).min(not_after_ms + 1),
    };
    (m, shape)
}

/// A cart the mandate allows, before any mutation.
fn cart(r: &mut Rng, s: &Shape, budget_left: i64) -> Context {
    let mut quantities = BTreeMap::new();
    for sku in r.subset(&s.skus, 1, 2) {
        let maybe = |r: &mut Rng, bound: &Option<String>, pool: &[&str]| match bound {
            Some(v) => Some(v.clone()),
            None if r.chance(50) => Some(r.pick(pool).to_string()),
            None => None,
        };
        let v = Variant {
            sku,
            size: maybe(r, &s.size, &SIZES[..3]),
            color: maybe(r, &s.color, &COLORS[..3]),
        };
        quantities.insert(v, r.range(1, s.max_qty));
    }
    let pool: Vec<String> = if s.categories.is_empty() {
        CATEGORY_IDS.iter().map(|c| c.to_string()).collect()
    } else {
        s.categories.clone()
    };
    let categories: BTreeSet<String> = r.subset(&pool, 1, 2).into_iter().collect();
    assert!(
        !categories.is_empty(),
        "a non-empty cart has at least one category"
    );
    let total = r.range(0, s.max_total.min(s.budget_max).min(budget_left).max(0));
    Context {
        currency: s.currency.clone(),
        total_minor: total,
        merchant: r.pick(&s.merchants).clone(),
        categories,
        variants: quantities.keys().cloned().collect(),
        max_line_qty: quantities.values().copied().max().unwrap_or(0),
        max_unit_minor: r.range(0, total),
        return_days: s.min_return_days + r.range(0, 30),
        returns_free: s.returns_free || r.chance(50),
        quantities,
    }
}

fn forbid(r: &mut Rng, id: &str, s: &Shape, i: &mut EvalInput) {
    let c = &mut i.context;
    match id {
        "agent" => {
            i.agent = if r.chance(50) {
                format!("{}/9999", REGISTRIES[0])
            } else {
                "other".to_owned()
            }
        }
        "sanity" => match r.below(2) {
            0 => c.total_minor = -r.range(1, 100),
            _ => c.max_unit_minor = -r.range(1, 100),
        },
        "currency" => c.currency = "CHF".to_owned(),
        "amount" => c.total_minor = s.max_total + r.range(1, 5_000),
        "budget" => {
            i.budget_left_minor = r.range(-100, c.total_minor.max(1) - 1);
            if c.total_minor == 0 {
                c.total_minor = 1;
            }
        }
        "merchant" => c.merchant = "mrc_unknown".to_owned(),
        "window" => {
            let ms = if r.chance(50) {
                s.nbf_ms - r.range(1, 86_400_000)
            } else {
                s.expires_ms + r.range(0, 86_400_000)
            };
            i.now = now(ms);
        }
        "quantity" => {
            let v = c.variants.iter().next().unwrap().clone();
            let q = s.max_qty + r.range(1, 3);
            c.quantities.insert(v, q);
            c.max_line_qty = *c.quantities.values().max().unwrap();
        }
        "category" => {
            let outside: Vec<&str> = CATEGORY_IDS
                .iter()
                .copied()
                .filter(|id| !s.categories.iter().any(|c| c == id))
                .collect();
            let id = if outside.is_empty() {
                "gpt:99999"
            } else {
                r.pick(&outside)
            };
            c.categories.insert(id.to_owned());
        }
        "variant" => {
            let q = c.quantities.pop_first().unwrap();
            let mut v = q.0;
            match (r.below(3), &s.size, &s.color) {
                (0, Some(_), _) => v.size = Some("13".to_owned()),
                (1, _, Some(_)) => v.color = None,
                _ => v.sku = "sku-unlisted".to_owned(),
            }
            c.quantities.insert(v, q.1);
            c.variants = c.quantities.keys().cloned().collect();
        }
        "returns" => {
            if s.min_return_days == 0 {
                c.return_days = -r.range(1, 10);
            } else {
                c.return_days = r.range(0, s.min_return_days - 1);
            }
        }
        _ => c.returns_free = false,
    }
}

/// Breaks one mandate field the entity reads, or the shape of its constraints.
fn break_mandate(r: &mut Rng, m: &mut Value) {
    fn find<'a>(m: &'a mut Value, group: &str, ty: &str) -> Option<&'a mut Value> {
        m[group]["constraints"]
            .as_array_mut()?
            .iter_mut()
            .find(|c| c["type"] == ty)
    }
    let bad = [
        json!(null),
        json!("x"),
        json!(1.5),
        json!([]),
        json!({}),
        json!(true),
        json!(-0.0),
        json!(9_007_199_254_740_992i64),
    ];
    let junk = r.pick(&bad).clone();
    match r.below(28) {
        0 => m["mid"] = junk,
        1 => m["payment"]["constraints"] = junk,
        2 => m["checkout"]["constraints"] = junk,
        3 => {
            let group = if r.chance(50) { "payment" } else { "checkout" };
            let list = m[group]["constraints"].as_array_mut().unwrap();
            let dup = list[r.below(list.len() as u64) as usize].clone();
            list.push(dup);
        }
        4 => {
            let ty = *r.pick(&[
                "payment.amount_range",
                "payment.budget",
                "payment.execution_date",
            ]);
            m["payment"]["constraints"]
                .as_array_mut()
                .unwrap()
                .retain(|c| c["type"] != ty);
        }
        5 => {
            m["checkout"]["constraints"]
                .as_array_mut()
                .unwrap()
                .retain(|c| c["type"] != "checkout.allowed_merchants");
        }
        6 => find(m, "payment", "payment.budget").unwrap()["max"] = junk,
        7 => find(m, "payment", "payment.amount_range").unwrap()["max"] = junk,
        8 => find(m, "checkout", "checkout.allowed_merchants").unwrap()["allowed"] = junk,
        9 => find(m, "checkout", "checkout.allowed_merchants").unwrap()["allowed"][0]["id"] = junk,
        10 => match find(m, "checkout", "keelson.returns") {
            Some(c) if r.chance(50) => c["min_days"] = junk,
            Some(c) => c["free"] = junk,
            None => m["checkout"]["constraints"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "type": "keelson.returns", "min_days": 1, "free": "yes" })),
        },
        11 => {
            let must = match r.below(4) {
                0 => json!({ "size_us": "10", "width": "wide" }),
                1 => json!({ "color": 7, "size_us": "10" }),
                2 => json!("size 10"),
                _ => json!({ "fit": 1, "color": "red" }),
            };
            m["checkout"]["constraints"]
                .as_array_mut()
                .unwrap()
                .retain(|c| c["type"] != "keelson.attributes");
            m["checkout"]["constraints"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "type": "keelson.attributes", "must": must }));
        }
        12 => find(m, "checkout", "checkout.line_items").unwrap()["items"] = junk,
        13 => find(m, "checkout", "checkout.line_items").unwrap()["items"][0]["quantity"] = junk,
        14 => {
            find(m, "checkout", "checkout.line_items").unwrap()["items"][0]["acceptable_items"] =
                junk
        }
        15 => {
            find(m, "checkout", "checkout.line_items").unwrap()["items"][0]["acceptable_items"][0]
                ["id"] = junk
        }
        16 => match find(m, "checkout", "keelson.category") {
            Some(c) if r.chance(50) => c["allow"] = junk,
            Some(c) => c["deny"] = json!(["gpt:1", 2]),
            None => m["checkout"]["constraints"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "type": "keelson.category", "allow": "gpt:1", "deny": 3 })),
        },
        17 => m["agent"]["operator"]["agent_registry"] = junk,
        18 => {
            m["agent"]["operator"]["agent_id"] = json!(*r.pick(&["007", "", "4a", "-1", "+5", "٣"]))
        }
        19 => m["payment"]["currency"] = junk,
        20 => m["nbf"] = junk,
        21 => m["exp"] = junk,
        22 => {
            find(m, "payment", "payment.execution_date").unwrap()["not_after"] = json!(*r.pick(&[
                "2026-11-13",
                "2026-02-30T00:00:00Z",
                "2026-11-13T24:00:00Z",
                "2026-11-13T23:59:59+24:00",
                "2026-11-13T23:59:59+05:60",
                "2026-11-13T23:59:60Z",
                "2026-11-13T23:59:59.Z",
                "2026-11-13T23:59:59",
                "2026-11-13T23:59:59Z ",
                "2026-11-13é23:59:59Z",
                "+2026-11-13T23:59:59Z",
            ]))
        }
        // Instants Cedar or the clock cannot represent.
        23 => {
            m["nbf"] = json!(*r.pick(&[-62_135_596_801i64, -62_198_755_200, 253_402_300_800]));
        }
        24 => m["exp"] = json!(*r.pick(&[-62_198_755_201i64, -377_705_116_801])),
        // A whole number written with a fraction is the same integer.
        25 => {
            let n = find(m, "payment", "payment.amount_range").unwrap()["max"]
                .as_i64()
                .unwrap();
            find(m, "payment", "payment.amount_range").unwrap()["max"] = json!(n as f64);
            m["nbf"] = json!(m["nbf"].as_i64().unwrap() as f64);
        }
        // Keys that name JavaScript object internals are data like any other.
        26 => match r.below(3) {
            0 => {
                let mid = m.as_object_mut().unwrap().remove("mid").unwrap();
                m["__proto__"] = json!({ "mid": mid });
            }
            1 => m["checkout"]["constraints"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "type": "keelson.attributes", "must": { "__proto__": "10" } })),
            _ => {
                m["payment"]["constraints"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({ "__proto__": { "type": "payment.budget", "max": 1 } }));
                m["constructor"] = json!({ "prototype": 1 });
            }
        },
        _ => m["agent"] = junk,
    }
}

/// Replaces the projected context with a raw one that is ill-formed in one way.
fn raw_context(r: &mut Rng, mut c: Value) -> Value {
    let attrs = [
        "currency",
        "total_minor",
        "merchant",
        "categories",
        "variants",
        "max_line_qty",
        "max_unit_minor",
        "return_days",
        "returns_free",
        "now_ms",
    ];
    let o = c.as_object_mut().unwrap();
    match r.below(15) {
        0 => {
            o.remove(*r.pick(&attrs));
        }
        // A whole number written with a fraction is the same integer.
        14 => {
            for attr in [
                "total_minor",
                "max_line_qty",
                "max_unit_minor",
                "return_days",
            ] {
                let n = o[attr].as_i64().unwrap();
                o.insert(attr.to_owned(), json!(n as f64));
            }
        }
        1 => {
            let bad = [
                json!(null),
                json!("1"),
                json!(1.5),
                json!([1]),
                json!({}),
                json!(false),
                json!(-0.0),
            ];
            o.insert(r.pick(&attrs).to_string(), r.pick(&bad).clone());
        }
        2 => {
            let key = *r.pick(&["price", "__proto__", "constructor", "prototype", "toString"]);
            o.insert(
                key.to_owned(),
                r.pick(&[json!(1), json!({ "size": "10" })]).clone(),
            );
        }
        3 => {
            o.insert("variants".to_owned(), json!([]));
        }
        4 => {
            let empty = [json!([]), json!([""]), json!(["gpt:1", ""])];
            o.insert("categories".to_owned(), r.pick(&empty).clone());
        }
        5 => {
            let int = *r.pick(&[1i64 << 53, -(1i64 << 53), 1 << 60]);
            o.insert(r.pick(&attrs[..]).to_string(), json!(int));
        }
        6 => {
            let now = [
                json!({ "__extn": { "fn": "datetime", "arg": "2026-11-05T17:02:11.250Z" } }),
                json!("1793750400000"),
                json!("2026-11-05T17:02:11.250Z"),
                json!(1_793_750_400_000.5),
                json!(1_793_750_400_000.0),
                json!(-62_167_219_200_001i64),
                json!(1_793_750_400i64),
                json!(null),
            ];
            o.insert("now_ms".to_owned(), r.pick(&now).clone());
        }
        7 => {
            let variants = [
                json!([{ "size": "10" }]),
                json!([{ "sku": "sku-a", "price": "1" }]),
                json!([{ "sku": 1 }]),
                json!([{ "sku": "sku-a", "size": 10 }]),
                json!(["sku-a"]),
                json!([{ "sku": "sku-a", "color": null }]),
                json!([{ "sku": "sku-a", "__proto__": "10" }]),
                json!([{ "sku": "sku-a", "__proto__": { "size": "10" } }]),
                json!([{ "sku": "sku-a", "constructor": "x" }]),
            ];
            o.insert("variants".to_owned(), r.pick(&variants).clone());
        }
        8 => {
            o.insert("categories".to_owned(), json!(["gpt:1", 1]));
        }
        9 => return json!([c]),
        10 => return json!(*r.pick(&[json!(null), json!("context"), json!(1)])),
        11 => {
            o.insert("total_minor".to_owned(), json!(-1));
        }
        // A well-formed replay: the same checks as a live evaluation, minus the quantities.
        _ => {}
    }
    c
}

/// Makes the quantities disagree with the variants or with `max_line_qty`.
fn break_quantities(r: &mut Rng, c: &mut Context) {
    match r.below(5) {
        0 => {
            let v = c.variants.iter().next().unwrap().clone();
            c.quantities.insert(v, *r.pick(&[0, -1, -7]));
        }
        1 => c.max_line_qty += r.range(1, 3),
        2 => {
            c.quantities.pop_first();
        }
        3 => {
            c.quantities.insert(
                Variant {
                    sku: "sku-extra".to_owned(),
                    size: None,
                    color: None,
                },
                1,
            );
            c.max_line_qty = *c.quantities.values().max().unwrap();
        }
        // Variants that only differ in an attribute the mandate leaves free merge when projected.
        _ => {
            let v = c.variants.iter().next().unwrap().clone();
            for color in ["red", "blue"] {
                let twin = Variant {
                    color: Some(color.to_owned()),
                    ..v.clone()
                };
                c.quantities.insert(twin, r.range(1, 3));
            }
            c.variants = c.quantities.keys().cloned().collect();
            c.max_line_qty = *c.quantities.values().max().unwrap();
        }
    }
}

fn extra(r: &mut Rng, valid: bool) -> Extra {
    if valid {
        match r.below(4) {
            0 => Extra::MaxUnitPrice {
                minor: r.range(1, 20_000),
            },
            1 => Extra::DenyMerchant {
                id: r.pick(&MERCHANTS).to_string(),
            },
            2 => Extra::DenyCategory {
                id: r.pick(&CATEGORY_IDS).to_string(),
            },
            _ => Extra::RequireReturnDays {
                min: r.range(0, 60),
            },
        }
    } else {
        match r.below(4) {
            0 => Extra::MaxUnitPrice {
                minor: *r.pick(&[0, -1, 1 << 53]),
            },
            1 => Extra::DenyMerchant {
                id: r
                    .pick(&["mrc_", "runfast", "mrc_a\u{200b}b", "mrc_\u{7}", "MRC_x"])
                    .to_string(),
            },
            2 => Extra::DenyCategory {
                id: r
                    .pick(&["gpt:0", "gpt:01", "gpt:", "gpt:12345678901", "gpt:1a", "1"])
                    .to_string(),
            },
            _ => Extra::RequireReturnDays {
                min: *r.pick(&[-1, 1 << 53]),
            },
        }
    }
}

fn epoch_ms(t: OffsetDateTime) -> i64 {
    i64::try_from(t.unix_timestamp_nanos().div_euclid(1_000_000)).expect("in range")
}

fn now(ms: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000).expect("in range")
}

fn case(r: &mut Rng, scenario: Scenario) -> Case {
    let (mut m, s) = mandate(r);
    let agent = mandate_agent(&m).unwrap();
    let budget_left = if r.chance(20) {
        s.budget_max + r.range(1, 10_000)
    } else {
        r.range(s.max_total.min(s.budget_max) / 2, s.budget_max)
    };
    let context = cart(r, &s, budget_left);
    let span = s.expires_ms - s.nbf_ms;
    let now_ms = if span > 0 {
        s.nbf_ms + r.range(0, span - 1)
    } else {
        s.nbf_ms
    };
    let mut evidence = BTreeMap::new();
    for field in r.subset(&FIELDS, 0, 3) {
        let sources = r.subset(&EVIDENCE, 1, 2);
        evidence.insert(
            field.to_owned(),
            sources.into_iter().map(str::to_owned).collect(),
        );
    }
    let mut mandate_hash = [0u8; 32];
    let mut cart_hash = [0u8; 32];
    for b in mandate_hash.iter_mut().chain(cart_hash.iter_mut()) {
        *b = r.next() as u8;
    }
    let mut extras = Vec::new();
    if r.chance(15) {
        extras.push(extra(r, true));
    }
    let mut raw = None;

    let mut input = EvalInput {
        mandate: Value::Null,
        budget_left_minor: budget_left,
        agent,
        context,
        now: now(now_ms),
        evidence,
        mandate_hash,
        cart_hash,
    };
    match scenario {
        Scenario::Allow => {}
        Scenario::Forbid(id) => forbid(r, id, &s, &mut input),
        Scenario::BadMandate => break_mandate(r, &mut m),
        Scenario::RawContext => {
            let mut c = serde_json::to_value(&input.context).unwrap();
            c["now_ms"] = json!(epoch_ms(input.now));
            raw = Some(raw_context(r, c));
        }
        Scenario::Quantities => break_quantities(r, &mut input.context),
        Scenario::WindowEdge => {
            let ms = match r.below(4) {
                0 => s.nbf_ms - 1,
                1 => s.nbf_ms,
                2 => s.expires_ms - 1,
                _ => s.expires_ms,
            };
            input.now = now(ms);
        }
        Scenario::Extras => {
            for _ in 0..r.range(1, 5) {
                extras.push(extra(r, true));
            }
        }
        Scenario::BadExtras => {
            let n = r.range(1, 4) as usize;
            extras = (0..n).map(|_| extra(r, true)).collect();
            let at = r.below(n as u64) as usize;
            extras[at] = extra(r, false);
        }
        Scenario::TooManyExtras => {
            let n = MAX_EXTRAS + r.range(1, 3) as usize;
            extras = (0..n).map(|_| extra(r, true)).collect();
        }
    }
    input.mandate = m;
    Case {
        input,
        raw_context: raw,
        extras,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn args() -> Result<(u64, usize), String> {
    let mut seed = None;
    let mut n = None;
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let value = it.next().ok_or(format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--seed" => seed = Some(value.parse().map_err(|e| format!("--seed: {e}"))?),
            "--n" => n = Some(value.parse().map_err(|e| format!("--n: {e}"))?),
            _ => return Err(format!("unknown flag {flag}")),
        }
    }
    Ok((
        seed.ok_or("--seed is required")?,
        n.ok_or("--n is required")?,
    ))
}

fn main() {
    let (seed, n) = args().unwrap_or_else(|e| {
        eprintln!("{e}\nusage: parity --seed <u64> --n <usize>");
        std::process::exit(2);
    });
    let meta = EngineMeta::new(
        "0.8.1",
        "1.3.1",
        &format!("sha256:{}", "a".repeat(64)),
        &format!("sha256:{}", "b".repeat(64)),
        &format!("sha256:{}", "c".repeat(64)),
    );
    let mut r = Rng(seed);
    let mut out = BufWriter::new(std::io::stdout().lock());
    for i in 0..n {
        let c = case(&mut r, SCENARIOS[i % SCENARIOS.len()]);
        let trace = match &c.raw_context {
            Some(raw) => evaluate_context_with_extras(&c.input, raw.clone(), &c.extras, &meta),
            None => evaluate_with_extras(&c.input, &c.extras, &meta),
        };
        let i = &c.input;
        let mut context = serde_json::to_value(&i.context).unwrap();
        context["quantities"] = json!(i.context.quantities.iter().collect::<Vec<_>>());
        let mut input = json!({
            "mandate": i.mandate,
            "budget_left_minor": i.budget_left_minor,
            "agent": i.agent,
            "context": context,
            "now_ms": i64::try_from(i.now.unix_timestamp_nanos() / 1_000_000).unwrap(),
            "evidence": i.evidence,
            "mandate_hash": hex(&i.mandate_hash),
            "cart_hash": hex(&i.cart_hash),
            "extras": c.extras,
            "meta": {
                "cedar_policy": meta.cedar_policy,
                "lang": meta.lang,
                "symcc": meta.symcc,
                "cvc5": meta.cvc5,
                "oci_digest": meta.oci_digest,
                "canonicalizer": meta.canonicalizer,
                "proof_bundle_hash": meta.proof_bundle_hash,
            },
        });
        if let Some(raw) = c.raw_context {
            input["raw_context"] = raw;
        }
        let line = json!({ "input": input, "trace_jcs_hex": hex(&trace_jcs(&trace)) });
        serde_json::to_writer(&mut out, &line).unwrap();
        out.write_all(b"\n").unwrap();
    }
    out.flush().unwrap();
}
