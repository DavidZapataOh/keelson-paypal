use serde::Serialize;
use serde_json::{Number, Value};

use crate::MAX_SAFE_INTEGER;

/// The trace format version.
pub const TRACE_VERSION: &str = "keelson.eval/1";

/// The outcome of an evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Deny,
}

/// The engine build that produced a trace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Engine {
    pub cedar_policy: String,
    pub lang: String,
    pub symcc: String,
    pub cvc5: String,
    pub oci_digest: String,
    pub canonicalizer: String,
}

/// The result of one policy, keyed by its `@id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FieldTrace {
    pub id: String,
    pub field: String,
    pub color: String,
    pub pass: bool,
    /// The context value the policy reads, in Cedar JSON form.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed: Option<Value>,
    /// The `Mandate` entity value the policy compares against, in Cedar JSON form.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bound: Option<Value>,
    pub evidence: Vec<String>,
}

/// A `keelson.eval/1` trace.
///
/// The `Mandate` entity can be rebuilt from `fields[].bound`, which together hold every entity
/// attribute; the policies never read the entity id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Trace {
    pub v: String,
    pub engine: Engine,
    pub policy_set_hash: String,
    pub schema_hash: String,
    pub proof_bundle_hash: String,
    /// `sha256:<hex>` of the JCS form of the extras, in the order given; absent without extras.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extras_hash: Option<String>,
    pub mandate_hash: String,
    pub cart_hash: String,
    /// The context passed to Cedar, in Cedar JSON form.
    pub context: Value,
    pub decision: Decision,
    /// The ids of the `forbid` policies that determined a deny, sorted.
    pub fired: Vec<String>,
    pub fields: Vec<FieldTrace>,
    /// Every error met while evaluating, sorted. Any error means deny.
    pub errors: Vec<String>,
    pub t_tee: String,
}

/// The trace as RFC 8785 canonical JSON.
///
/// # Panics
///
/// If the trace holds a number that is not a safe integer. Traces from [`crate::evaluate`] never
/// do: such numbers are carried as strings.
pub fn trace_jcs(t: &Trace) -> Vec<u8> {
    let mut out = Vec::with_capacity(4096);
    if write_trace(&mut out, t).is_some() {
        return out;
    }
    let value = serde_json::to_value(t).expect("a trace serializes to JSON");
    keelson_core::jcs(&value)
        .expect("a trace holds only safe integers")
        .into_bytes()
}

/// Writes the trace with its members in RFC 8785 order, or returns `None` at a number that is
/// not a safe integer.
fn write_trace(out: &mut Vec<u8>, t: &Trace) -> Option<()> {
    let e = &t.engine;
    out.extend_from_slice(b"{\"cart_hash\":");
    write_str(out, &t.cart_hash);
    out.extend_from_slice(b",\"context\":");
    write_value(out, &t.context)?;
    out.extend_from_slice(match t.decision {
        Decision::Allow => b",\"decision\":\"allow\"".as_slice(),
        Decision::Deny => b",\"decision\":\"deny\"",
    });
    out.extend_from_slice(b",\"engine\":{\"canonicalizer\":");
    write_str(out, &e.canonicalizer);
    out.extend_from_slice(b",\"cedar_policy\":");
    write_str(out, &e.cedar_policy);
    out.extend_from_slice(b",\"cvc5\":");
    write_str(out, &e.cvc5);
    out.extend_from_slice(b",\"lang\":");
    write_str(out, &e.lang);
    out.extend_from_slice(b",\"oci_digest\":");
    write_str(out, &e.oci_digest);
    out.extend_from_slice(b",\"symcc\":");
    write_str(out, &e.symcc);
    out.extend_from_slice(b"},\"errors\":");
    write_strs(out, &t.errors);
    if let Some(hash) = &t.extras_hash {
        out.extend_from_slice(b",\"extras_hash\":");
        write_str(out, hash);
    }
    out.extend_from_slice(b",\"fields\":[");
    for (i, f) in t.fields.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        out.push(b'{');
        if let Some(bound) = &f.bound {
            out.extend_from_slice(b"\"bound\":");
            write_value(out, bound)?;
            out.push(b',');
        }
        out.extend_from_slice(b"\"color\":");
        write_str(out, &f.color);
        out.extend_from_slice(b",\"evidence\":");
        write_strs(out, &f.evidence);
        out.extend_from_slice(b",\"field\":");
        write_str(out, &f.field);
        out.extend_from_slice(b",\"id\":");
        write_str(out, &f.id);
        if let Some(observed) = &f.observed {
            out.extend_from_slice(b",\"observed\":");
            write_value(out, observed)?;
        }
        out.extend_from_slice(if f.pass {
            b",\"pass\":true}".as_slice()
        } else {
            b",\"pass\":false}"
        });
    }
    out.extend_from_slice(b"],\"fired\":");
    write_strs(out, &t.fired);
    out.extend_from_slice(b",\"mandate_hash\":");
    write_str(out, &t.mandate_hash);
    out.extend_from_slice(b",\"policy_set_hash\":");
    write_str(out, &t.policy_set_hash);
    out.extend_from_slice(b",\"proof_bundle_hash\":");
    write_str(out, &t.proof_bundle_hash);
    out.extend_from_slice(b",\"schema_hash\":");
    write_str(out, &t.schema_hash);
    out.extend_from_slice(b",\"t_tee\":");
    write_str(out, &t.t_tee);
    out.extend_from_slice(b",\"v\":");
    write_str(out, &t.v);
    out.push(b'}');
    Some(())
}

fn write_strs(out: &mut Vec<u8>, items: &[String]) {
    out.push(b'[');
    for (i, s) in items.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        write_str(out, s);
    }
    out.push(b']');
}

/// Writes `v` as RFC 8785 does: members sorted by their UTF-16 code units, and numbers as
/// integers once JavaScript would read them as one (`1.0` is `1`, `-0` is `0`).
fn write_value(out: &mut Vec<u8>, v: &Value) -> Option<()> {
    match v {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(b) => out.extend_from_slice(if *b { b"true" } else { b"false" }),
        Value::Number(n) => write_int(out, safe_int(n)?),
        Value::String(s) => write_str(out, s),
        Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_value(out, item)?;
            }
            out.push(b']');
        }
        Value::Object(map) => {
            let mut members: Vec<_> = map.iter().collect();
            members.sort_unstable_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            out.push(b'{');
            for (i, (key, value)) in members.into_iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_str(out, key);
                out.push(b':');
                write_value(out, value)?;
            }
            out.push(b'}');
        }
    }
    Some(())
}

/// The safe integer a JSON number stands for, as [`keelson_core::jcs`] reads it.
fn safe_int(n: &Number) -> Option<i64> {
    let safe = -MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER;
    if let Some(i) = n.as_i64() {
        return safe.contains(&i).then_some(i);
    }
    if n.is_u64() {
        return None;
    }
    let f = n.as_f64().filter(|f| f.is_finite() && f.fract() == 0.0)?;
    // The bound is checked, so the cast is exact.
    #[allow(clippy::cast_possible_truncation)]
    (f.abs() <= MAX_SAFE_INTEGER as f64).then_some(f as i64)
}

fn write_int(out: &mut Vec<u8>, n: i64) {
    let mut digits = [0u8; 20];
    let mut at = digits.len();
    let mut rest = n.unsigned_abs();
    loop {
        at -= 1;
        // A single decimal digit.
        #[allow(clippy::cast_possible_truncation)]
        let digit = (rest % 10) as u8;
        digits[at] = b'0' + digit;
        rest /= 10;
        if rest == 0 {
            break;
        }
    }
    if n < 0 {
        out.push(b'-');
    }
    out.extend_from_slice(&digits[at..]);
}

/// Writes a JSON string as RFC 8785 does: `"` and `\` escaped, the controls with a short escape
/// written with it, the other controls as `\u00xx` in lowercase hex, and every other character as
/// itself.
fn write_str(out: &mut Vec<u8>, s: &str) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(b'"');
    let bytes = s.as_bytes();
    let mut start = 0;
    for (i, &b) in bytes.iter().enumerate() {
        let escape: &[u8] = match b {
            b'"' => b"\\\"",
            b'\\' => b"\\\\",
            0x08 => b"\\b",
            b'\t' => b"\\t",
            b'\n' => b"\\n",
            0x0c => b"\\f",
            b'\r' => b"\\r",
            0x00..=0x1f => &[
                b'\\',
                b'u',
                b'0',
                b'0',
                HEX[usize::from(b >> 4)],
                HEX[usize::from(b & 0xf)],
            ],
            _ => continue,
        };
        out.extend_from_slice(&bytes[start..i]);
        out.extend_from_slice(escape);
        start = i + 1;
    }
    out.extend_from_slice(&bytes[start..]);
    out.push(b'"');
}
