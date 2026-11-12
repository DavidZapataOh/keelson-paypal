//! Reads a card transaction and its card from the issuer (Lithic) inside leg A, so a settlement is
//! signed from what the issuer answered over TLS, not from what the host forwarded.
//!
//! `GET /v1/transactions/{token}` and `GET /v1/cards/{token}`, with the API key in the
//! `Authorization` header, as Lithic's API reference specifies.

use std::time::Duration;

use crate::chain;

const SANDBOX: &str = "https://sandbox.lithic.com";
const LIVE: &str = "https://api.lithic.com";
const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_BODY: usize = 64 * 1024;

/// A Lithic client holding the program's API key, sealed in the leg's encrypted environment.
pub struct LithicClient {
    base: &'static str,
    key: String,
    http: reqwest::Client,
}

impl LithicClient {
    /// The client for `LITHIC_API_KEY` on the sandbox, or on the live API when `LITHIC_ENV` is
    /// `live`; `None` when no key is set.
    pub fn from_env() -> Result<Option<Self>, String> {
        let key = std::env::var("LITHIC_API_KEY").unwrap_or_default();
        if key.is_empty() {
            return Ok(None);
        }
        let base = match std::env::var("LITHIC_ENV").as_deref() {
            Ok("live") => LIVE,
            Ok("sandbox") | Err(_) => SANDBOX,
            Ok(_) => return Err("LITHIC_ENV must be sandbox or live".into()),
        };
        Ok(Some(Self {
            base,
            key,
            http: chain::http_client(),
        }))
    }

    async fn get(&self, path: &str) -> Result<Vec<u8>, String> {
        let response = self
            .http
            .get(format!("{}{path}", self.base))
            .timeout(TIMEOUT)
            .header("Authorization", &self.key)
            .send()
            .await
            .map_err(|_| "lithic request failed".to_string())?;
        if !response.status().is_success() {
            return Err(format!("lithic answered {}", response.status().as_u16()));
        }
        let body = response
            .bytes()
            .await
            .map_err(|_| "lithic response failed".to_string())?;
        if body.len() > MAX_BODY {
            return Err("lithic response too large".into());
        }
        Ok(body.to_vec())
    }

    /// The raw transaction and card, exactly as Lithic sent them.
    pub async fn read(&self, transaction: &str, card: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
        let ok = |s: &str| s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if !ok(transaction) || !ok(card) {
            return Err("malformed token".into());
        }
        let t = self.get(&format!("/v1/transactions/{transaction}")).await?;
        let c = self.get(&format!("/v1/cards/{card}")).await?;
        Ok((t, c))
    }
}
