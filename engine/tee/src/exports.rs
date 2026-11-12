//! Standard exports leg A signs with its attested credential-issuer key (ES256).
//!
//! An export is signed only over facts a logged statement backs: the statement carries a receipt
//! this leg's own log key signed, its claims verify, `keelson.facts` is exactly the statement's
//! projection, and every pointer the export's profile binds holds the bound fact.

use serde::Deserialize;
use serde_json::{Value, json};

/// One fact an export binds, at an RFC 6901 pointer, with how the standard spells it.
#[derive(Deserialize)]
pub(crate) struct Row {
    pub pointer: String,
    pub fact: String,
    #[serde(default)]
    pub transform: Option<String>,
}

/// An export profile: the JWS `typ` it is signed with and the facts it binds.
#[derive(Deserialize)]
pub(crate) struct Profile {
    pub profile: String,
    pub typ: String,
    pub rows: Vec<Row>,
}

/// The profiles leg A signs, embedded in the measured image.
pub(crate) fn profiles() -> &'static [Profile] {
    static PROFILES: std::sync::OnceLock<Vec<Profile>> = std::sync::OnceLock::new();
    PROFILES.get_or_init(|| {
        serde_json::from_str(include_str!("export_bindings.json"))
            .expect("export_bindings.json is valid")
    })
}

/// The facts an export states about a purchase, as `keelson.facts` spells them.
pub(crate) fn facts(c: &keelson_core::eip712::Countersign, request_id: &str) -> Value {
    let hex = |b: &[u8]| -> String {
        format!(
            "0x{}",
            b.iter().map(|x| format!("{x:02x}")).collect::<String>()
        )
    };
    json!({
        "agent_id": c.agentId.to_string(),
        "amount_minor": c.amount.to_string(),
        "cart_hash": hex(c.cartHash.as_slice()),
        "currency": c.currency.to_string(),
        "decision": if c.decision == 1 { "allow" } else { "deny" },
        "issued_at": c.issuedAt.to::<u64>(),
        "mandate_hash": hex(c.mandateHash.as_slice()),
        "merchant_id": hex(c.merchantId.as_slice()),
        "request_id": request_id,
    })
}

/// Whether `value` is `fact` as `transform` spells it.
pub(crate) fn holds(
    value: &Value,
    fact: &Value,
    transform: Option<&str>,
    c: &keelson_core::eip712::Countersign,
) -> bool {
    let currency = keelson_core::currency_code(c.currency);
    match transform {
        None => value == fact,
        Some("Minor") => value == &json!(c.amount) || value == &json!(c.amount.to_string()),
        Some("Major") => currency.is_some_and(|code| {
            keelson_core::to_paypal_value(&keelson_core::Money {
                currency: code.into(),
                minor: i128::from(c.amount),
            })
            .is_ok_and(|major| {
                value == &json!(major) || value.as_f64() == major.parse::<f64>().ok()
            })
        }),
        Some("UpperCurrency") => currency.is_some_and(|code| value == &json!(code)),
        Some("LowerCurrency") => currency.is_some_and(|code| value == &json!(code.to_lowercase())),
        Some("UlidOfRequest") => value == fact,
        Some("StatusOfDecision") => {
            value == &json!(if c.decision == 1 { "Success" } else { "Error" })
        }
        Some(_) => false,
    }
}

/// Compact JSON with every character outside `' '..='~'` escaped as `\uXXXX` (UTF-16), byte-equal
/// to Python's `json.dumps(v, separators=(",", ":"), ensure_ascii=True)`.
pub fn ascii_json(v: &Value) -> String {
    let compact = serde_json::to_string(v).expect("a Value always serializes");
    let mut out = String::with_capacity(compact.len());
    for ch in compact.chars() {
        if (' '..='~').contains(&ch) || ch == '\n' || ch == '\r' || ch == '\t' {
            out.push(ch);
        } else {
            let mut units = [0u16; 2];
            for unit in ch.encode_utf16(&mut units) {
                out.push_str(&format!("\\u{unit:04x}"));
            }
        }
    }
    out
}
