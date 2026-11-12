//! The open mandate's entry in Keelson's Token Status List (draft-ietf-oauth-status-list-21).

use serde_json::{Value, json};

use crate::Error;

/// Where Keelson publishes the status list of its mandates.
pub const STATUS_URI: &str = "https://api.keelson.finance/status/v1/mandates/2026-1";
/// How many mandates the list holds, one bit each.
pub const STATUS_SIZE: u32 = 131_072;

/// An open mandate's place in a status list: its `status.status_list` claim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusRef {
    pub idx: u32,
    pub uri: String,
}

impl StatusRef {
    /// The `status` claim (draft-ietf-oauth-status-list-21 section 6.1).
    pub fn claim(&self) -> Value {
        json!({ "status_list": { "idx": self.idx, "uri": self.uri } })
    }

    /// Reads a `status` claim: exactly `{"status_list": {"idx", "uri"}}`, the index inside the
    /// list and the URI Keelson's.
    pub fn from_claim(v: &Value) -> Result<Self, Error> {
        let bad = || Error::Credential("open_status".into());
        let status = v.as_object().filter(|o| o.len() == 1).ok_or_else(bad)?;
        let list = status
            .get("status_list")
            .and_then(Value::as_object)
            .filter(|o| o.len() == 2)
            .ok_or_else(bad)?;
        let idx = list
            .get("idx")
            .and_then(Value::as_u64)
            .filter(|i| *i < u64::from(STATUS_SIZE))
            .ok_or_else(bad)?;
        let uri = list
            .get("uri")
            .and_then(Value::as_str)
            .filter(|u| *u == STATUS_URI)
            .ok_or_else(bad)?;
        Ok(Self {
            idx: u32::try_from(idx).map_err(|_| bad())?,
            uri: uri.to_owned(),
        })
    }
}
