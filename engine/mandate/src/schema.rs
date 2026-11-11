use serde_json::{Map, Value};

use crate::unicode::is_control_or_format;
use crate::{CATEGORY_IDS, Error};

/// The `acceptable_items` id that stands for any SKU. A mandate that uses it has a single line,
/// whose only acceptable item it is, and a `keelson.category` constraint; its `title` describes
/// what the user wants and is not blank.
pub const ANY_ITEM: &str = "*";

/// Maximum lifetime of a mandate, in seconds.
pub const MAX_LIFETIME_SECONDS: i64 = 30 * 86400;

/// Maximum UTF-8 length, in bytes, of each free-form string; mirrors `STRING_LIMITS` in the
/// TypeScript schema.
const SHORT: usize = 128;
const MEDIUM: usize = 256;
const SUMMARY: usize = 1024;
const URL: usize = 2048;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

const CURRENCIES: [&str; 24] = [
    "AUD", "BRL", "CAD", "CNY", "CZK", "DKK", "EUR", "HKD", "HUF", "ILS", "JPY", "MYR", "MXN",
    "TWD", "NZD", "NOK", "PHP", "PLN", "GBP", "SGD", "SEK", "CHF", "THB", "USD",
];

const PAYMENT_REQUIRED: [&str; 4] = [
    "payment.amount_range",
    "payment.budget",
    "payment.allowed_payees",
    "payment.execution_date",
];
const CHECKOUT_OPTIONAL: [&str; 4] = [
    "checkout.line_items",
    "keelson.category",
    "keelson.attributes",
    "keelson.returns",
];

type Result<T = ()> = std::result::Result<T, Error>;

fn invalid(path: &str, reason: &str) -> Error {
    Error::mandate(path, reason)
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_owned()
    } else {
        format!("{path}.{key}")
    }
}

/// An object with exactly the given keys, where keys marked `?` may be absent. `check` validates
/// the members first and unrecognized keys are rejected after it, the order in which the
/// TypeScript schema reports them, so both name the same field. A missing key reaches `check` as
/// `null`.
fn strict<'a, T>(
    v: &'a Value,
    path: &str,
    keys: &[&str],
    check: impl FnOnce(&'a Map<String, Value>) -> Result<T>,
) -> Result<T> {
    let obj = v
        .as_object()
        .ok_or_else(|| invalid(path, "expected object"))?;
    let out = check(obj)?;
    for key in obj.keys() {
        if !keys.iter().any(|k| k.trim_end_matches('?') == key) {
            return Err(invalid(path, &format!("unrecognized key {key:?}")));
        }
    }
    Ok(out)
}

fn get<'a>(obj: &'a Map<String, Value>, key: &str) -> &'a Value {
    obj.get(key).unwrap_or(&Value::Null)
}

fn string<'a>(v: &'a Value, path: &str) -> Result<&'a str> {
    v.as_str().ok_or_else(|| invalid(path, "expected string"))
}

/// A string of at most `max` UTF-8 bytes (non-empty unless `empty`) with no Unicode control (Cc)
/// or format (Cf) characters.
fn text<'a>(v: &'a Value, path: &str, max: usize, empty: bool) -> Result<&'a str> {
    let s = string(v, path)?;
    if !empty && s.is_empty() {
        return Err(invalid(path, "too small"));
    }
    if s.chars().any(is_control_or_format) {
        return Err(invalid(path, "control or format characters"));
    }
    if s.len() > max {
        return Err(invalid(path, "too long"));
    }
    Ok(s)
}

/// Whether `s` is a valid merchant `id`: 1 to 128 UTF-8 bytes with no Unicode control (Cc) or
/// format (Cf) characters.
pub fn is_merchant_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= SHORT && !s.chars().any(is_control_or_format)
}

fn matching<'a>(v: &'a Value, path: &str, ok: impl Fn(&str) -> bool) -> Result<&'a str> {
    let s = string(v, path)?;
    if !ok(s) {
        return Err(invalid(path, "invalid format"));
    }
    Ok(s)
}

fn literal(v: &Value, path: &str, expected: &str) -> Result {
    if v.as_str() != Some(expected) {
        return Err(invalid(path, &format!("expected {expected:?}")));
    }
    Ok(())
}

fn boolean(v: &Value, path: &str) -> Result {
    v.as_bool()
        .map(|_| ())
        .ok_or_else(|| invalid(path, "expected boolean"))
}

/// A safe integer (`|n| <= 2^53 - 1`) that is at least `min`.
fn integer(v: &Value, path: &str, min: f64) -> Result<i64> {
    let n = v.as_f64().ok_or_else(|| invalid(path, "expected number"))?;
    if n.fract() != 0.0 || n.abs() > MAX_SAFE_INTEGER {
        return Err(invalid(path, "expected safe integer"));
    }
    if n < min {
        return Err(invalid(path, "too small"));
    }
    Ok(n as i64)
}

fn array<'a>(v: &'a Value, path: &str, min: usize) -> Result<&'a [Value]> {
    let items = v
        .as_array()
        .ok_or_else(|| invalid(path, "expected array"))?;
    if items.len() < min {
        return Err(invalid(path, "too small"));
    }
    Ok(items)
}

fn each(v: &Value, path: &str, min: usize, f: impl Fn(&Value, &str) -> Result) -> Result {
    for (i, item) in array(v, path, min)?.iter().enumerate() {
        f(item, &join(path, &i.to_string()))?;
    }
    Ok(())
}

fn chars_in(s: &[u8], ok: impl Fn(u8) -> bool) -> bool {
    s.iter().copied().all(ok)
}

fn is_b64url_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

fn is_lower_hex(b: u8) -> bool {
    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
}

/// Unpadded base64url of exactly `bytes` bytes with zero pad bits.
fn is_b64url_bytes(s: &str, last: &[u8], bytes: usize) -> bool {
    let len = (bytes * 8).div_ceil(6);
    match s.as_bytes().split_last() {
        Some((end, body)) if s.len() == len => chars_in(body, is_b64url_char) && last.contains(end),
        _ => false,
    }
}

fn is_b64url16(s: &str) -> bool {
    is_b64url_bytes(s, b"AQgw", 16)
}

fn is_b64url32(s: &str) -> bool {
    is_b64url_bytes(s, b"AEIMQUYcgkosw048", 32)
}

fn is_prefixed_hex(s: &str, prefix: &str) -> bool {
    s.strip_prefix(prefix)
        .is_some_and(|h| h.len() == 64 && chars_in(h.as_bytes(), is_lower_hex))
}

fn is_sha256(s: &str) -> bool {
    is_prefixed_hex(s, "sha256:")
}

/// A ULID: 26 Crockford base32 characters whose first is at most `7`.
fn is_ulid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 26
        && (b'0'..=b'7').contains(&b[0])
        && b[1..].iter().all(|c| {
            c.is_ascii_digit()
                || (c.is_ascii_uppercase() && !matches!(c, b'I' | b'L' | b'O' | b'U'))
        })
}

/// Reads two to four ASCII digits.
fn digits(b: &[u8]) -> Option<u32> {
    b.iter().try_fold(0u32, |n, c| {
        c.is_ascii_digit().then(|| n * 10 + u32::from(c - b'0'))
    })
}

/// An RFC 3339 UTC date-time with seconds and optional fraction: `YYYY-MM-DDThh:mm:ss[.f+]Z`.
fn is_datetime(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' {
        return false;
    }
    if b[16] != b':' || b[b.len() - 1] != b'Z' {
        return false;
    }
    let (Some(year), Some(month), Some(day)) =
        (digits(&b[0..4]), digits(&b[5..7]), digits(&b[8..10]))
    else {
        return false;
    };
    let (Some(hour), Some(minute), Some(second)) =
        (digits(&b[11..13]), digits(&b[14..16]), digits(&b[17..19]))
    else {
        return false;
    };
    let fraction = &b[19..b.len() - 1];
    if !fraction.is_empty()
        && (fraction[0] != b'.'
            || fraction.len() < 2
            || !fraction[1..].iter().all(u8::is_ascii_digit))
    {
        return false;
    }
    let leap = if year % 100 == 0 {
        (year / 100) % 4 == 0
    } else {
        year % 4 == 0
    };
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day) && hour < 24 && minute < 60 && second < 60
}

/// ECMAScript `String.prototype.trim` whitespace.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

fn is_label(l: &[u8]) -> bool {
    let alnum = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    (1..=63).contains(&l.len())
        && l.first().is_some_and(alnum)
        && l.last().is_some_and(alnum)
        && l.iter().all(|b| alnum(b) || *b == b'-')
}

fn is_path_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@/?#%".contains(&b)
}

/// Whether `s` is `https://`, a lowercase ASCII host name whose last label starts with a letter,
/// and an optional path, with no port or user info: a subset of what every WHATWG URL parser
/// accepts, checked the same way in every language.
fn is_website(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("https://") else {
        return false;
    };
    let (host, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    let mut labels = host.as_bytes().split(|b| *b == b'.');
    host.len() <= 253
        && labels.clone().all(is_label)
        && labels
            .next_back()
            .is_some_and(|l| l.first().is_some_and(u8::is_ascii_lowercase))
        && path.bytes().all(is_path_char)
}

/// Whether `s` is a serialized https origin as `URL.origin` writes it: `https://`, a host name as
/// [`is_website`] takes it and an optional port other than 443, without leading zeros.
fn is_https_origin(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("https://") else {
        return false;
    };
    let (host, port) = match rest.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (rest, None),
    };
    let port_ok = port.is_none_or(|port| {
        (1..=5).contains(&port.len())
            && !port.starts_with('0')
            && port.bytes().all(|b| b.is_ascii_digit())
            && port.parse::<u32>().is_ok_and(|p| p <= 65_535 && p != 443)
    });
    port_ok && !host.contains('/') && is_website(&format!("https://{host}"))
}

fn p256_jwk(v: &Value, path: &str, kid: bool) -> Result {
    let keys: &[&str] = if kid {
        &["kty", "crv", "x", "y", "kid"]
    } else {
        &["kty", "crv", "x", "y"]
    };
    strict(v, path, keys, |jwk| {
        literal(get(jwk, "kty"), &join(path, "kty"), "EC")?;
        literal(get(jwk, "crv"), &join(path, "crv"), "P-256")?;
        matching(get(jwk, "x"), &join(path, "x"), is_b64url32)?;
        matching(get(jwk, "y"), &join(path, "y"), is_b64url32)?;
        if kid {
            text(get(jwk, "kid"), &join(path, "kid"), SHORT, false)?;
        }
        Ok(())
    })
}

fn currency(v: &Value, path: &str) -> Result {
    let c = string(v, path)?;
    if !CURRENCIES.contains(&c) {
        return Err(invalid(path, "invalid currency"));
    }
    Ok(())
}

fn constraint_type<'a>(c: &'a Value, path: &str) -> Result<&'a str> {
    let ty = c
        .as_object()
        .ok_or_else(|| invalid(path, "expected object"))?
        .get("type")
        .and_then(Value::as_str);
    ty.ok_or_else(|| invalid(&join(path, "type"), "invalid discriminator"))
}

fn payment_constraint(c: &Value, path: &str) -> Result {
    let p = |k: &str| join(path, k);
    match constraint_type(c, path)? {
        "payment.amount_range" | "payment.budget" => {
            strict(c, path, &["type", "max", "currency"], |o| {
                integer(get(o, "max"), &p("max"), 0.0)?;
                currency(get(o, "currency"), &p("currency"))
            })
        }
        "payment.allowed_payees" => strict(c, path, &["type", "allowed"], |o| {
            each(get(o, "allowed"), &p("allowed"), 1, |v, path| {
                strict(v, path, &["paypal_merchant_id"], |payee| {
                    text(
                        get(payee, "paypal_merchant_id"),
                        &join(path, "paypal_merchant_id"),
                        SHORT,
                        false,
                    )
                    .map(drop)
                })
            })
        }),
        "payment.execution_date" => strict(c, path, &["type", "not_after"], |o| {
            matching(get(o, "not_after"), &p("not_after"), is_datetime).map(drop)
        }),
        _ => Err(invalid(&p("type"), "invalid discriminator")),
    }
}

/// A category id from [`CATEGORY_IDS`].
fn category(v: &Value, path: &str) -> Result {
    if !CATEGORY_IDS.contains(&string(v, path)?) {
        return Err(invalid(path, "unknown category"));
    }
    Ok(())
}

fn merchant(v: &Value, path: &str) -> Result {
    strict(
        v,
        path,
        &["id", "name", "website", "paypal_merchant_id"],
        |m| {
            text(get(m, "id"), &join(path, "id"), SHORT, false)?;
            text(get(m, "name"), &join(path, "name"), SHORT, false)?;
            if matching(get(m, "website"), &join(path, "website"), is_website)?.len() > URL {
                return Err(invalid(&join(path, "website"), "too long"));
            }
            text(
                get(m, "paypal_merchant_id"),
                &join(path, "paypal_merchant_id"),
                SHORT,
                false,
            )
            .map(drop)
        },
    )
}

fn line_item(v: &Value, path: &str) -> Result {
    strict(v, path, &["id", "acceptable_items", "quantity"], |item| {
        text(get(item, "id"), &join(path, "id"), SHORT, false)?;
        each(
            get(item, "acceptable_items"),
            &join(path, "acceptable_items"),
            1,
            |v, path| {
                strict(v, path, &["id", "title?"], |a| {
                    text(get(a, "id"), &join(path, "id"), SHORT, false)?;
                    match a.get("title") {
                        Some(t) => text(t, &join(path, "title"), MEDIUM, true).map(drop),
                        None => Ok(()),
                    }
                })
            },
        )?;
        integer(get(item, "quantity"), &join(path, "quantity"), 1.0).map(drop)
    })
}

/// Whether a line accepts any item. Such a line accepts nothing else, and its title, which says
/// what the user wants, is not blank.
fn any_item(line: &Value, path: &str) -> Result<bool> {
    let path = join(path, "acceptable_items");
    let items = array(&line["acceptable_items"], &path, 1)?;
    if !items.iter().any(|a| a["id"] == ANY_ITEM) {
        return Ok(false);
    }
    if items.len() > 1 {
        return Err(invalid(&path, "any item must be the only item"));
    }
    let title = items[0]["title"].as_str().unwrap_or_default();
    if title.trim_matches(is_js_whitespace).is_empty() {
        return Err(invalid(&join(&path, "0.title"), "required for any item"));
    }
    Ok(true)
}

fn checkout_constraint(c: &Value, path: &str) -> Result {
    let p = |k: &str| join(path, k);
    match constraint_type(c, path)? {
        "checkout.allowed_merchants" => strict(c, path, &["type", "allowed"], |o| {
            each(get(o, "allowed"), &p("allowed"), 1, merchant)
        }),
        "checkout.line_items" => strict(c, path, &["type", "items"], |o| {
            each(get(o, "items"), &p("items"), 0, line_item)
        }),
        "keelson.category" => strict(c, path, &["type", "allow", "deny"], |o| {
            each(get(o, "allow"), &p("allow"), 1, category)?;
            each(get(o, "deny"), &p("deny"), 0, category)
        }),
        "keelson.attributes" => strict(c, path, &["type", "must"], |o| {
            let must = get(o, "must")
                .as_object()
                .ok_or_else(|| invalid(&p("must"), "expected record"))?;
            for (k, v) in must {
                let path = join(&p("must"), k);
                text(&Value::String(k.clone()), &path, SHORT, true)?;
                text(v, &path, MEDIUM, true)?;
            }
            Ok(())
        }),
        "keelson.returns" => strict(c, path, &["type", "min_days", "free"], |o| {
            integer(get(o, "min_days"), &p("min_days"), 0.0)?;
            boolean(get(o, "free"), &p("free"))
        }),
        _ => Err(invalid(&p("type"), "invalid discriminator")),
    }
}

fn strings(v: &Value, path: &str) -> Result {
    each(v, path, 0, |v, path| text(v, path, MEDIUM, true).map(drop))
}

/// Each required type appears exactly once and each optional type at most once.
fn require_counts(
    field: &str,
    constraints: &[Value],
    required: &[&str],
    optional: &[&str],
) -> Result {
    for ty in required.iter().chain(optional) {
        let n = constraints
            .iter()
            .filter(|c| c.get("type").and_then(Value::as_str) == Some(ty))
            .count();
        let is_required = required.contains(ty);
        if n > 1 || (n == 0 && is_required) {
            let quantity = if is_required {
                "exactly one"
            } else {
                "at most one"
            };
            return Err(invalid(field, &format!("expected {quantity} {ty}")));
        }
    }
    Ok(())
}

/// Checks the members of a mandate in schema order and returns it with `iat`, `nbf` and `exp`.
fn members(root: &Map<String, Value>) -> Result<(&Map<String, Value>, i64, i64, i64)> {
    let at = |k: &str| get(root, k);
    literal(at("v"), "v", "keelson.mandate.1")?;
    matching(at("mid"), "mid", is_ulid)?;
    let iat = integer(at("iat"), "iat", 0.0)?;
    let nbf = integer(at("nbf"), "nbf", 0.0)?;
    let exp = integer(at("exp"), "exp", 0.0)?;
    matching(at("nonce"), "nonce", is_b64url16)?;
    let mode = string(at("mode"), "mode")?;
    if mode != "immediate" && mode != "autonomous" {
        return Err(invalid("mode", "invalid option"));
    }

    strict(
        at("user"),
        "user",
        &["sub", "cred", "app_login_id"],
        |user| {
            text(get(user, "sub"), "user.sub", SHORT, false)?;
            strict(
                get(user, "cred"),
                "user.cred",
                &["id", "rp_id", "jwk"],
                |cred| {
                    matching(get(cred, "id"), "user.cred.id", crate::b64::is_base64url)?;
                    text(get(cred, "rp_id"), "user.cred.rp_id", SHORT, false)?;
                    p256_jwk(get(cred, "jwk"), "user.cred.jwk", false)
                },
            )?;
            text(
                get(user, "app_login_id"),
                "user.app_login_id",
                MEDIUM,
                false,
            )
            .map(drop)
        },
    )?;

    strict(
        at("agent"),
        "agent",
        &["operator", "cnf", "bond"],
        |agent| {
            strict(
                get(agent, "operator"),
                "agent.operator",
                &["agent_registry", "agent_id"],
                |operator| {
                    text(
                        get(operator, "agent_registry"),
                        "agent.operator.agent_registry",
                        MEDIUM,
                        false,
                    )?;
                    text(
                        get(operator, "agent_id"),
                        "agent.operator.agent_id",
                        SHORT,
                        false,
                    )
                    .map(drop)
                },
            )?;
            strict(get(agent, "cnf"), "agent.cnf", &["jwk"], |cnf| {
                p256_jwk(get(cnf, "jwk"), "agent.cnf.jwk", true)
            })?;
            strict(
                get(agent, "bond"),
                "agent.bond",
                &["vault", "asset", "min"],
                |bond| {
                    text(get(bond, "vault"), "agent.bond.vault", MEDIUM, false)?;
                    text(get(bond, "asset"), "agent.bond.asset", SHORT, false)?;
                    integer(get(bond, "min"), "agent.bond.min", 0.0).map(drop)
                },
            )
        },
    )?;

    strict(
        at("payment"),
        "payment",
        &["rail", "currency", "constraints"],
        |payment| {
            literal(get(payment, "rail"), "payment.rail", "paypal")?;
            currency(get(payment, "currency"), "payment.currency")?;
            each(
                get(payment, "constraints"),
                "payment.constraints",
                0,
                payment_constraint,
            )
        },
    )?;

    strict(at("checkout"), "checkout", &["constraints"], |checkout| {
        each(
            get(checkout, "constraints"),
            "checkout.constraints",
            0,
            checkout_constraint,
        )
    })?;

    strict(
        at("intent"),
        "intent",
        &["prompt_summary", "prompt_hash", "subjective"],
        |intent| {
            text(
                get(intent, "prompt_summary"),
                "intent.prompt_summary",
                SUMMARY,
                true,
            )?;
            matching(get(intent, "prompt_hash"), "intent.prompt_hash", is_sha256)?;
            strings(get(intent, "subjective"), "intent.subjective")
        },
    )?;

    strict(
        at("policy"),
        "policy",
        &["engine", "version", "policy_set_hash", "measurements"],
        |policy| {
            text(get(policy, "engine"), "policy.engine", SHORT, false)?;
            text(get(policy, "version"), "policy.version", SHORT, false)?;
            matching(
                get(policy, "policy_set_hash"),
                "policy.policy_set_hash",
                is_sha256,
            )?;
            strings(get(policy, "measurements"), "policy.measurements")
        },
    )?;

    strict(
        at("consent"),
        "consent",
        &[
            "terms_hash",
            "instruction_use",
            "responsibility_ack",
            "merchant_policy_ack",
            "recurrence_ack",
        ],
        |consent| {
            matching(get(consent, "terms_hash"), "consent.terms_hash", is_sha256)?;
            boolean(get(consent, "instruction_use"), "consent.instruction_use")?;
            boolean(
                get(consent, "responsibility_ack"),
                "consent.responsibility_ack",
            )?;
            text(
                get(consent, "merchant_policy_ack"),
                "consent.merchant_policy_ack",
                SHORT,
                false,
            )?;
            boolean(get(consent, "recurrence_ack"), "consent.recurrence_ack")
        },
    )?;

    strict(at("zk"), "zk", &["commitment"], |zk| {
        matching(get(zk, "commitment"), "zk.commitment", |s| {
            is_prefixed_hex(s, "0x")
        })
        .map(drop)
    })?;

    strict(at("risk_data"), "risk_data", &["device_fp", "ip"], |risk| {
        text(get(risk, "device_fp"), "risk_data.device_fp", SHORT, true)?;
        text(get(risk, "ip"), "risk_data.ip", SHORT, true).map(drop)
    })?;

    if let Some(embed) = root.get("embed") {
        strict(embed, "embed", &["top_origin"], |e| {
            matching(get(e, "top_origin"), "embed.top_origin", is_https_origin).map(drop)
        })?;
    }
    Ok((root, iat, nbf, exp))
}

/// Validates a `keelson.mandate.1` payload: unknown keys and constraint types are rejected, and
/// the error names the offending field.
pub fn parse_mandate(m: &Value) -> Result {
    let keys = [
        "v",
        "mid",
        "iat",
        "nbf",
        "exp",
        "nonce",
        "mode",
        "user",
        "agent",
        "payment",
        "checkout",
        "intent",
        "policy",
        "consent",
        "zk",
        "risk_data",
        "embed?",
    ];
    let (root, iat, nbf, exp) = strict(m, "", &keys, members)?;
    let at = |k: &str| get(root, k);
    let payment = at("payment").as_object().expect("checked by members");
    let checkout = at("checkout").as_object().expect("checked by members");
    if nbf < iat {
        return Err(invalid("nbf", "nbf is before iat"));
    }
    if nbf > exp {
        return Err(invalid("nbf", "nbf is after exp"));
    }
    if exp - iat > MAX_LIFETIME_SECONDS {
        return Err(invalid("exp", "lifetime exceeds 30 days"));
    }
    let payment_constraints = array(get(payment, "constraints"), "payment.constraints", 0)?;
    require_counts(
        "payment.constraints",
        payment_constraints,
        &PAYMENT_REQUIRED,
        &[],
    )?;
    let checkout_constraints = array(get(checkout, "constraints"), "checkout.constraints", 0)?;
    require_counts(
        "checkout.constraints",
        checkout_constraints,
        &["checkout.allowed_merchants"],
        &CHECKOUT_OPTIONAL,
    )?;
    for (i, c) in payment_constraints.iter().enumerate() {
        if let Some(cur) = c.get("currency")
            && Some(cur) != payment.get("currency")
        {
            return Err(invalid(
                &format!("payment.constraints.{i}.currency"),
                "differs from payment.currency",
            ));
        }
    }
    for (i, c) in checkout_constraints.iter().enumerate() {
        if c["type"] != "checkout.line_items" {
            continue;
        }
        let path = format!("checkout.constraints.{i}.items");
        let lines = array(&c["items"], &path, 0)?;
        let mut any = false;
        for (j, line) in lines.iter().enumerate() {
            any |= any_item(line, &join(&path, &j.to_string()))?;
        }
        if !any {
            continue;
        }
        if lines.len() > 1 {
            return Err(invalid(&path, "any item must be the only line"));
        }
        if !checkout_constraints
            .iter()
            .any(|k| k["type"] == "keelson.category")
        {
            return Err(invalid(
                "checkout.constraints",
                "any item requires keelson.category",
            ));
        }
    }
    Ok(())
}
