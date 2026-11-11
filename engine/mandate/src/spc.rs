use keelson_core::{Money, to_paypal_value};
use serde_json::Value;

use crate::Error;

/// The WebAuthn RP ID every passkey is scoped to.
pub const RP_ID: &str = "keelson.finance";
/// The origin of the approval page agent platforms frame. A passkey assertion made in it is
/// cross-origin, and its mandate names the top-level page in `embed.top_origin`.
pub const EMBED_ORIGIN: &str = "https://api.keelson.finance";
/// The Secure Payment Confirmation payee name.
pub const SPC_PAYEE_NAME: &str = "Keelson";
/// The SPC payee origin: Keelson at its RP ID domain.
pub const SPC_PAYEE_ORIGIN: &str = "https://keelson.finance";
/// The display name of the payment instrument every mandate is confirmed with.
pub const SPC_INSTRUMENT_DISPLAY_NAME: &str = "Keelson mandate";
/// The icon of the payment instrument every mandate is confirmed with.
pub const SPC_INSTRUMENT_ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' rx='6' fill='%23111'/%3E%3C/svg%3E";

/// What the browser's Secure Payment Confirmation dialog shows for a mandate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpcDetails {
    pub payee_name: String,
    pub payee_origin: String,
    /// ISO 4217 code of the total.
    pub currency: String,
    /// The total as a PayPal decimal string.
    pub value: String,
}

/// The SPC dialog details for a parsed mandate: Keelson at [`SPC_PAYEE_ORIGIN`] as the payee and
/// the per-purchase cap, `payment.amount_range.max`, as the total.
pub fn spc_details(m: &Value) -> Result<SpcDetails, Error> {
    let payment = &m["payment"];
    let currency = payment["currency"]
        .as_str()
        .ok_or_else(|| Error::mandate("payment.currency", "missing"))?;
    let max = payment["constraints"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|c| c["type"] == "payment.amount_range")
        .and_then(|c| c["max"].as_u64())
        .ok_or_else(|| Error::mandate("payment.constraints", "lacks amount_range"))?;
    let value = to_paypal_value(&Money {
        currency: currency.to_owned(),
        minor: max.into(),
    })?;
    Ok(SpcDetails {
        payee_name: SPC_PAYEE_NAME.to_owned(),
        payee_origin: SPC_PAYEE_ORIGIN.to_owned(),
        currency: currency.to_owned(),
        value,
    })
}
