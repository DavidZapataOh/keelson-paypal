use std::collections::BTreeSet;

use keelson_canon::{Context, Variant};
use keelson_policy::{
    Decision, Engine, EngineMeta, EvalInput, Extra, FieldTrace, Trace, evaluate,
    evaluate_context_with_extras, evaluate_with_extras, trace_jcs,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;

/// The trace as `keelson_core::jcs` writes it.
fn reference(t: &Trace) -> Vec<u8> {
    keelson_core::jcs(&serde_json::to_value(t).unwrap())
        .unwrap()
        .into_bytes()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> [u8; 32] {
    let mut out = [0; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

fn variant(v: &Value) -> Variant {
    let text = |key: &str| v.get(key).map(|s| s.as_str().unwrap().to_owned());
    Variant {
        sku: text("sku").unwrap(),
        size: text("size"),
        color: text("color"),
    }
}

/// One case of the committed parity sample: the evaluator inputs, the raw context and extras.
fn case(line: &str) -> (EvalInput, Option<Value>, Vec<Extra>, EngineMeta, String) {
    let line: Value = serde_json::from_str(line).unwrap();
    let i = &line["input"];
    let c = &i["context"];
    let strings = |v: &Value| -> BTreeSet<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_owned())
            .collect()
    };
    let context = Context {
        currency: c["currency"].as_str().unwrap().to_owned(),
        total_minor: c["total_minor"].as_i64().unwrap(),
        merchant: c["merchant"].as_str().unwrap().to_owned(),
        categories: strings(&c["categories"]),
        variants: c["variants"]
            .as_array()
            .unwrap()
            .iter()
            .map(variant)
            .collect(),
        max_line_qty: c["max_line_qty"].as_i64().unwrap(),
        max_unit_minor: c["max_unit_minor"].as_i64().unwrap(),
        return_days: c["return_days"].as_i64().unwrap(),
        returns_free: c["returns_free"].as_bool().unwrap(),
        quantities: c["quantities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|q| (variant(&q[0]), q[1].as_i64().unwrap()))
            .collect(),
    };
    let evidence = i["evidence"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), serde_json::from_value(v.clone()).unwrap()))
        .collect();
    let m = &i["meta"];
    let text = |key: &str| m[key].as_str().unwrap().to_owned();
    let meta = EngineMeta {
        cedar_policy: text("cedar_policy"),
        lang: text("lang"),
        symcc: text("symcc"),
        cvc5: text("cvc5"),
        oci_digest: text("oci_digest"),
        canonicalizer: text("canonicalizer"),
        proof_bundle_hash: text("proof_bundle_hash"),
    };
    let now_ms = i128::from(i["now_ms"].as_i64().unwrap());
    let input = EvalInput {
        mandate: i["mandate"].clone(),
        budget_left_minor: i["budget_left_minor"].as_i64().unwrap(),
        agent: i["agent"].as_str().unwrap().to_owned(),
        context,
        now: OffsetDateTime::from_unix_timestamp_nanos(now_ms * 1_000_000).unwrap(),
        evidence,
        mandate_hash: unhex(i["mandate_hash"].as_str().unwrap()),
        cart_hash: unhex(i["cart_hash"].as_str().unwrap()),
    };
    let extras = serde_json::from_value(i["extras"].clone()).unwrap();
    let expected = line["trace_jcs_hex"].as_str().unwrap().to_owned();
    (input, i.get("raw_context").cloned(), extras, meta, expected)
}

fn run(input: &EvalInput, raw: &Option<Value>, extras: &[Extra], meta: &EngineMeta) -> Trace {
    match raw {
        Some(raw) => evaluate_context_with_extras(input, raw.clone(), extras, meta),
        None => evaluate_with_extras(input, extras, meta),
    }
}

#[test]
fn parity_sample_is_unchanged_with_warm_and_cold_caches() {
    let lines: Vec<&str> = include_str!("../../../packages/policy/test/vectors/parity.jsonl")
        .lines()
        .filter(|l| !l.is_empty())
        .collect();
    assert!(lines.len() > 100);
    let cases: Vec<_> = lines.iter().map(|l| case(l)).collect();
    // Each case twice in a row, so the second run reads every cache the first one filled.
    for (input, raw, extras, meta, expected) in &cases {
        for _ in 0..2 {
            let t = run(input, raw, extras, meta);
            let bytes = trace_jcs(&t);
            assert_eq!(bytes, reference(&t));
            assert_eq!(&hex(&bytes), expected);
        }
    }
    // A fresh thread starts with empty caches.
    std::thread::spawn(move || {
        for (input, raw, extras, meta, expected) in cases.iter().rev() {
            assert_eq!(&hex(&trace_jcs(&run(input, raw, extras, meta))), expected);
        }
    })
    .join()
    .unwrap();
}

#[test]
fn mandate_cache_never_serves_another_mandate() {
    let (input, _, _, meta, _) = case(
        include_str!("../../../packages/policy/test/vectors/parity.jsonl")
            .lines()
            .next()
            .unwrap(),
    );
    let cold = |i: &EvalInput| {
        let (i, meta) = (i.clone(), meta.clone());
        std::thread::spawn(move || trace_jcs(&evaluate(&i, &meta)))
            .join()
            .unwrap()
    };
    let mut i = input.clone();
    assert_eq!(trace_jcs(&evaluate(&i, &meta)), cold(&i));
    // Same hash and budget, different values the entity reads.
    i.mandate["payment"]["currency"] = json!("EUR");
    assert_eq!(trace_jcs(&evaluate(&i, &meta)), cold(&i));
    i.mandate["nbf"] = json!(i.mandate["nbf"].as_i64().unwrap() as f64 + 0.5);
    assert_eq!(trace_jcs(&evaluate(&i, &meta)), cold(&i));
    i.mandate["nbf"] = json!(-0.0);
    assert_eq!(trace_jcs(&evaluate(&i, &meta)), cold(&i));
    i.mandate["nbf"] = json!(0.0);
    assert_eq!(trace_jcs(&evaluate(&i, &meta)), cold(&i));
    i.mandate = input.mandate.clone();
    i.budget_left_minor -= 1;
    assert_eq!(trace_jcs(&evaluate(&i, &meta)), cold(&i));
    // Members the entity never reads do not change the trace.
    let mut j = input.clone();
    j.mandate["user"] = json!({ "sub": "someone else" });
    assert_eq!(
        trace_jcs(&evaluate(&j, &meta)),
        trace_jcs(&evaluate(&input, &meta))
    );
}

#[test]
fn extras_cache_never_serves_another_list() {
    let (input, _, _, meta, _) = case(
        include_str!("../../../packages/policy/test/vectors/parity.jsonl")
            .lines()
            .next()
            .unwrap(),
    );
    let lists = [
        vec![Extra::MaxUnitPrice { minor: 1 }],
        vec![Extra::MaxUnitPrice { minor: 2 }],
        vec![Extra::MaxUnitPrice { minor: 0 }],
        vec![
            Extra::RequireReturnDays { min: 1 },
            Extra::MaxUnitPrice { minor: 2 },
        ],
        vec![
            Extra::MaxUnitPrice { minor: 2 },
            Extra::RequireReturnDays { min: 1 },
        ],
        vec![],
    ];
    let cold: Vec<Vec<u8>> = {
        let (lists, input, meta) = (lists.clone(), input.clone(), meta.clone());
        std::thread::spawn(move || {
            lists
                .iter()
                .map(|e| trace_jcs(&evaluate_with_extras(&input, e, &meta)))
                .collect()
        })
        .join()
        .unwrap()
    };
    for _ in 0..2 {
        for (extras, cold) in lists.iter().zip(&cold) {
            assert_eq!(
                &trace_jcs(&evaluate_with_extras(&input, extras, &meta)),
                cold
            );
        }
    }
}

/// SplitMix64.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn text(&mut self) -> String {
        const CHARS: [char; 24] = [
            'a',
            'Z',
            '0',
            ' ',
            '"',
            '\\',
            '/',
            '\u{0}',
            '\u{8}',
            '\t',
            '\n',
            '\u{b}',
            '\u{c}',
            '\r',
            '\u{1f}',
            '\u{7f}',
            'é',
            '\u{2028}',
            '\u{e000}',
            '\u{ff5e}',
            '\u{fffd}',
            '😀',
            '\u{10ffff}',
            '_',
        ];
        (0..self.below(6))
            .map(|_| CHARS[self.below(CHARS.len())])
            .collect()
    }

    fn strings(&mut self) -> Vec<String> {
        (0..self.below(3)).map(|_| self.text()).collect()
    }

    fn number(&mut self) -> Value {
        let max = (1i64 << 53) - 1;
        match self.below(6) {
            0 => json!(max),
            1 => json!(-max),
            2 => json!(-0.0),
            3 => json!((self.below(1000) as f64) * 1e3),
            4 => json!(self.below(10)),
            _ => json!(-(self.below(1 << 20) as i64)),
        }
    }

    fn value(&mut self, depth: usize) -> Value {
        match self.below(if depth == 0 { 4 } else { 6 }) {
            0 => Value::Null,
            1 => json!(self.below(2) == 0),
            2 => self.number(),
            3 => json!(self.text()),
            4 => Value::Array((0..self.below(4)).map(|_| self.value(depth - 1)).collect()),
            _ => {
                let mut map = Map::new();
                for _ in 0..self.below(5) {
                    map.insert(self.text(), self.value(depth - 1));
                }
                Value::Object(map)
            }
        }
    }

    fn maybe_value(&mut self) -> Option<Value> {
        (self.below(4) > 0).then(|| self.value(3))
    }

    fn trace(&mut self) -> Trace {
        Trace {
            v: self.text(),
            engine: Engine {
                cedar_policy: self.text(),
                lang: self.text(),
                symcc: self.text(),
                cvc5: self.text(),
                oci_digest: self.text(),
                canonicalizer: self.text(),
            },
            policy_set_hash: self.text(),
            schema_hash: self.text(),
            proof_bundle_hash: self.text(),
            extras_hash: (self.below(2) == 0).then(|| self.text()),
            mandate_hash: self.text(),
            cart_hash: self.text(),
            context: self.value(4),
            decision: if self.below(2) == 0 {
                Decision::Allow
            } else {
                Decision::Deny
            },
            fired: self.strings(),
            fields: (0..self.below(4))
                .map(|_| FieldTrace {
                    id: self.text(),
                    field: self.text(),
                    color: self.text(),
                    pass: self.below(2) == 0,
                    observed: self.maybe_value(),
                    bound: self.maybe_value(),
                    evidence: self.strings(),
                })
                .collect(),
            errors: self.strings(),
            t_tee: self.text(),
        }
    }
}

#[test]
fn generated_traces_match_the_reference_canonicalizer() {
    let mut r = Rng(7);
    for _ in 0..10_000 {
        let t = r.trace();
        assert_eq!(trace_jcs(&t), reference(&t), "{t:?}");
    }
}

#[test]
#[should_panic(expected = "a trace holds only safe integers")]
fn unsafe_numbers_still_panic() {
    let mut t = Rng(1).trace();
    t.context = json!({ "n": 1.5 });
    trace_jcs(&t);
}

#[test]
fn object_members_sort_by_utf16_code_units() {
    let mut t = Rng(3).trace();
    // U+1F600 sorts after U+FF5E in UTF-8 but before it in UTF-16, as a surrogate pair.
    t.context = json!({ "\u{ff5e}": 2, "😀": 1, "a": 3 });
    let text = String::from_utf8(trace_jcs(&t)).unwrap();
    assert!(
        text.contains(r#""context":{"a":3,"😀":1,"～":2}"#),
        "{text}"
    );
}
