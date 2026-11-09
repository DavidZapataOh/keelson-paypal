//! Reads a PayPal authorization from inside the leg and checks it against the mandate.
//!
//! The reads follow the PayPal REST API: `GET /v2/payments/authorizations/{id}` (Payments v2)
//! and `GET /v2/checkout/orders/{id}` (Orders v2), authenticated with an OAuth 2.0 client
//! credentials token. The engine has no other source of what was authorized or captured.

use serde_json::Value;

use keelson_canon::Context;

use crate::wire::PayPalObservation;

/// Why the PayPal authorization cannot back the cart. A refusal is a signed DENY.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayPalDeny {
    /// The authorization is neither `CREATED` nor `PARTIALLY_CAPTURED`.
    Status,
    /// The payee is not one of the mandate's `payment.allowed_payees`.
    Payee,
    /// The authorization is not in the cart's currency.
    Currency,
    /// What is left of the authorization is less than the cart's total.
    Insufficient,
    /// The authorization does not hold funds for this mandate.
    Mandate,
    /// The authorization expired, whatever its status says.
    Expired,
    /// The amounts cannot all be true: a capture with nothing captured, or more captured than
    /// authorized.
    Inconsistent,
    /// The mandate is already held by another PayPal order.
    HoldMismatch,
}

impl PayPalDeny {
    /// The stable reason recorded in the trace.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Status => "paypal.status",
            Self::Payee => "paypal.payee",
            Self::Currency => "paypal.currency",
            Self::Insufficient => "paypal.insufficient",
            Self::Mandate => "paypal.mandate",
            Self::Expired => "paypal.expired",
            Self::Inconsistent => "paypal.inconsistent",
            Self::HoldMismatch => "paypal.hold_mismatch",
        }
    }
}

/// What a PayPal authorization holds funds for, read from its `custom_id`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HoldKind {
    /// The mandate's hold, `ks1.<env>m.<mid>.<digest>`, for every purchase under the mandate.
    Mandate,
    /// One purchase's hold, `ks1.<env>a.<request id>.<digest>`, for that request only.
    Purchase,
}

/// Checks the observation against the mandate `m`, the cart's `ctx` and the countersign's
/// `request_id`, and says which kind of hold the authorization is.
///
/// `live` selects the environment the `custom_id` must name (`p`, else `s`), so a sandbox hold
/// never backs a live countersign and the reverse.
pub(crate) fn paypal_check(
    m: &Value,
    obs: &PayPalObservation,
    ctx: &Context,
    request_id: &str,
    live: bool,
) -> Result<HoldKind, PayPalDeny> {
    if !matches!(obs.status.as_str(), "CREATED" | "PARTIALLY_CAPTURED") {
        return Err(PayPalDeny::Status);
    }
    if obs.expires_at_ms <= obs.read_at_ms {
        return Err(PayPalDeny::Expired);
    }
    let payee = m["payment"]["constraints"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|c| c["type"] == "payment.allowed_payees")
        .and_then(|c| c["allowed"].as_array())
        .into_iter()
        .flatten()
        .any(|p| p["paypal_merchant_id"].as_str() == Some(obs.payee_merchant_id.as_str()));
    if !payee {
        return Err(PayPalDeny::Payee);
    }
    if obs.currency != ctx.currency {
        return Err(PayPalDeny::Currency);
    }
    let mid = m["mid"].as_str().unwrap_or_default();
    let kind = hold_kind(&obs.custom_id, mid, request_id, live).ok_or(PayPalDeny::Mandate)?;
    let nothing_captured = obs.status == "PARTIALLY_CAPTURED" && obs.captured_minor == 0;
    if nothing_captured || obs.captured_minor > obs.authorized_minor {
        return Err(PayPalDeny::Inconsistent);
    }
    if obs.authorized_minor.saturating_sub(obs.captured_minor) < ctx.total_minor {
        return Err(PayPalDeny::Insufficient);
    }
    Ok(kind)
}

/// The kind of hold `custom_id` is in this environment: `ks1.<env>m.<mid>.<digest>` for the
/// mandate `mid`, or `ks1.<env>a.<request_id>.<digest>` for the request `request_id`, with a
/// 43-character base64url digest. `None` for anything else.
fn hold_kind(custom_id: &str, mid: &str, request_id: &str, live: bool) -> Option<HoldKind> {
    let env = if live { 'p' } else { 's' };
    let parts: Vec<&str> = custom_id.split('.').collect();
    let ["ks1", kind, id, digest] = parts[..] else {
        return None;
    };
    let base64url = |c: u8| c.is_ascii_alphanumeric() || c == b'-' || c == b'_';
    if id.len() != 26 || digest.len() != 43 || !digest.bytes().all(base64url) {
        return None;
    }
    match kind.strip_prefix(env)? {
        "m" if id == mid => Some(HoldKind::Mandate),
        "a" if id == request_id => Some(HoldKind::Purchase),
        _ => None,
    }
}

#[cfg(feature = "tdx")]
pub use client::{PayPalClient, PayPalError, observe, parse};

#[cfg(feature = "tdx")]
mod client {
    use std::collections::{BTreeMap, HashMap};
    use std::fmt;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use serde::Deserialize;
    use time::OffsetDateTime;
    use ulid::Ulid;

    use crate::wire::{Base64, PayPalObservation};
    use crate::{chain, engine::unix_ms};

    const SANDBOX: &str = "https://api-m.sandbox.paypal.com";
    const LIVE: &str = "https://api-m.paypal.com";
    /// The longest any one PayPal call may take; a countersign never retries.
    const TIMEOUT: Duration = Duration::from_secs(5);
    /// A cached token is dropped this long before PayPal says it expires.
    const TOKEN_MARGIN: Duration = Duration::from_secs(60);
    const MAX_BODY: usize = 64 * 1024;

    /// Why a PayPal read failed.
    #[derive(Debug)]
    pub enum PayPalError {
        Http(reqwest::Error),
        Status(u16),
        Malformed(&'static str),
    }

    impl fmt::Display for PayPalError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                Self::Http(e) if e.is_timeout() => f.write_str("paypal request timed out"),
                Self::Http(_) => f.write_str("paypal request failed"),
                Self::Status(code) => write!(f, "paypal answered {code}"),
                Self::Malformed(what) => write!(f, "paypal sent a malformed {what}"),
            }
        }
    }

    impl std::error::Error for PayPalError {}

    impl From<reqwest::Error> for PayPalError {
        fn from(e: reqwest::Error) -> Self {
            Self::Http(e)
        }
    }

    struct Token {
        value: String,
        valid_until: Instant,
    }

    /// A PayPal REST client holding the OAuth 2.0 client credentials of the engine's app.
    pub struct PayPalClient {
        base: String,
        client_id: String,
        client_secret: String,
        http: reqwest::Client,
        token: Mutex<Option<Token>>,
        /// The order each authorization belongs to, which never changes once PayPal has said it.
        orders: Mutex<HashMap<String, String>>,
    }

    impl PayPalClient {
        /// Whether the client reads the live API rather than the sandbox.
        pub fn is_live(&self) -> bool {
            self.base == LIVE
        }

        /// A client for the REST API at `base` (no trailing slash).
        pub fn new(base: &str, client_id: &str, client_secret: &str) -> Self {
            Self {
                base: base.trim_end_matches('/').to_owned(),
                client_id: client_id.to_owned(),
                client_secret: client_secret.to_owned(),
                http: chain::http_client(),
                token: Mutex::new(None),
                orders: Mutex::new(HashMap::new()),
            }
        }

        /// The client for `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` on the sandbox, or on the
        /// live API when `PAYPAL_ENV` is `live`.
        pub fn from_env() -> Result<Self, String> {
            let var = |name: &str| std::env::var(name).map_err(|_| format!("{name} is not set"));
            let base = match std::env::var("PAYPAL_ENV").as_deref() {
                Ok("live") => LIVE,
                Ok("sandbox") | Err(_) => SANDBOX,
                Ok(_) => return Err("PAYPAL_ENV must be sandbox or live".into()),
            };
            Ok(Self::new(
                base,
                &var("PAYPAL_CLIENT_ID")?,
                &var("PAYPAL_CLIENT_SECRET")?,
            ))
        }

        fn cached(&self) -> Option<String> {
            let token = self.token.lock().unwrap_or_else(|e| e.into_inner());
            token
                .as_ref()
                .filter(|t| t.valid_until > Instant::now())
                .map(|t| t.value.clone())
        }

        async fn bearer(&self) -> Result<String, PayPalError> {
            if let Some(token) = self.cached() {
                return Ok(token);
            }
            #[derive(Deserialize)]
            struct Granted {
                access_token: String,
                expires_in: u64,
            }
            let response = self
                .http
                .post(format!("{}/v1/oauth2/token", self.base))
                .timeout(TIMEOUT)
                .basic_auth(&self.client_id, Some(&self.client_secret))
                .form(&[("grant_type", "client_credentials")])
                .send()
                .await?;
            let status = response.status();
            if !status.is_success() {
                return Err(PayPalError::Status(status.as_u16()));
            }
            let granted: Granted = response
                .json()
                .await
                .map_err(|_| PayPalError::Malformed("token"))?;
            let valid_until = Instant::now()
                + Duration::from_secs(granted.expires_in).saturating_sub(TOKEN_MARGIN);
            *self.token.lock().unwrap_or_else(|e| e.into_inner()) = Some(Token {
                value: granted.access_token.clone(),
                valid_until,
            });
            Ok(granted.access_token)
        }

        async fn get(&self, path: &str) -> Result<Vec<u8>, PayPalError> {
            let response = self
                .http
                .get(format!("{}{path}", self.base))
                .timeout(TIMEOUT)
                .bearer_auth(self.bearer().await?)
                .send()
                .await?;
            let status = response.status();
            if status == reqwest::StatusCode::UNAUTHORIZED {
                *self.token.lock().unwrap_or_else(|e| e.into_inner()) = None;
            }
            if !status.is_success() {
                return Err(PayPalError::Status(status.as_u16()));
            }
            let body = response.bytes().await?;
            if body.len() > MAX_BODY {
                return Err(PayPalError::Malformed("response"));
            }
            Ok(body.to_vec())
        }
    }

    #[derive(Deserialize)]
    struct Amount {
        currency_code: String,
        value: String,
    }

    #[derive(Deserialize)]
    struct Authorization {
        id: String,
        status: String,
        amount: Amount,
        #[serde(default)]
        custom_id: String,
        payee: Payee,
        expiration_time: String,
        supplementary_data: Supplementary,
    }

    #[derive(Deserialize)]
    struct Payee {
        merchant_id: String,
    }

    #[derive(Deserialize)]
    struct Supplementary {
        related_ids: RelatedIds,
    }

    #[derive(Deserialize)]
    struct RelatedIds {
        order_id: String,
    }

    #[derive(Deserialize)]
    struct Order {
        purchase_units: Vec<PurchaseUnit>,
    }

    #[derive(Deserialize)]
    struct PurchaseUnit {
        #[serde(default)]
        payments: Payments,
    }

    #[derive(Default, Deserialize)]
    struct Payments {
        #[serde(default)]
        captures: Vec<Capture>,
    }

    #[derive(Deserialize)]
    struct Capture {
        status: String,
        amount: Amount,
        #[serde(default)]
        invoice_id: String,
        #[serde(default)]
        links: Vec<Link>,
    }

    #[derive(Deserialize)]
    struct Link {
        href: String,
        rel: String,
    }

    /// PayPal ids are upper-case alphanumerics; anything else is never put in a path.
    fn valid_id(id: &str) -> bool {
        (1..=32).contains(&id.len())
            && id
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    }

    fn minor(a: &Amount) -> Result<i64, PayPalError> {
        keelson_core::from_paypal_value(&a.currency_code, &a.value)
            .ok()
            .and_then(|m| i64::try_from(m.minor).ok())
            .filter(|minor| *minor >= 0)
            .ok_or(PayPalError::Malformed("amount"))
    }

    /// The most authorizations whose order is remembered.
    const MAX_ORDERS: usize = 4096;

    /// Reads the authorization and its order, fresh, with no retries.
    ///
    /// The order is read at the same time as the authorization once the authorization's order is
    /// known from an earlier read; the authorization must then name that same order.
    pub async fn observe(
        client: &PayPalClient,
        authorization_id: &str,
    ) -> Result<PayPalObservation, PayPalError> {
        if !valid_id(authorization_id) {
            return Err(PayPalError::Malformed("authorization id"));
        }
        let authorization = format!("/v2/payments/authorizations/{authorization_id}");
        let known = client
            .orders
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(authorization_id)
            .cloned();
        let (raw_authorization, raw_order) = match known {
            Some(order_id) => {
                let order = format!("/v2/checkout/orders/{order_id}");
                let (raw_authorization, raw_order) =
                    tokio::try_join!(client.get(&authorization), client.get(&order))?;
                if order_id_of(&raw_authorization)? != order_id {
                    return Err(PayPalError::Malformed("authorization"));
                }
                (raw_authorization, raw_order)
            }
            None => {
                let raw_authorization = client.get(&authorization).await?;
                let order_id = order_id_of(&raw_authorization)?;
                let raw_order = client
                    .get(&format!("/v2/checkout/orders/{order_id}"))
                    .await?;
                let mut orders = client.orders.lock().unwrap_or_else(|e| e.into_inner());
                if orders.len() >= MAX_ORDERS {
                    orders.clear();
                }
                orders.insert(authorization_id.to_owned(), order_id);
                (raw_authorization, raw_order)
            }
        };
        let read_at_ms = unix_ms(OffsetDateTime::now_utc()).unwrap_or_default();
        parse(authorization_id, raw_authorization, raw_order, read_at_ms)
    }

    fn order_id_of(raw_authorization: &[u8]) -> Result<String, PayPalError> {
        let authorization: Authorization = serde_json::from_slice(raw_authorization)
            .map_err(|_| PayPalError::Malformed("authorization"))?;
        let id = authorization.supplementary_data.related_ids.order_id;
        valid_id(&id)
            .then_some(id)
            .ok_or(PayPalError::Malformed("authorization"))
    }

    /// The observation PayPal's two response bodies make, read at `read_at_ms`.
    ///
    /// `captured_minor` sums every capture of this authorization except `DECLINED` and `FAILED`
    /// ones, at its full amount: a refund does not restore the hold.
    pub fn parse(
        authorization_id: &str,
        raw_authorization: Vec<u8>,
        raw_order: Vec<u8>,
        read_at_ms: i64,
    ) -> Result<PayPalObservation, PayPalError> {
        let authorization: Authorization = serde_json::from_slice(&raw_authorization)
            .map_err(|_| PayPalError::Malformed("authorization"))?;
        let order_id = &authorization.supplementary_data.related_ids.order_id;
        if authorization.id != authorization_id || !valid_id(order_id) {
            return Err(PayPalError::Malformed("authorization"));
        }
        let order: Order =
            serde_json::from_slice(&raw_order).map_err(|_| PayPalError::Malformed("order"))?;

        let mut captured: i64 = 0;
        let mut order_captured: i64 = 0;
        let mut captured_by_request = BTreeMap::new();
        let captures = order
            .purchase_units
            .iter()
            .flat_map(|u| &u.payments.captures);
        for capture in captures {
            // Every capture of the order must name the authorization it drew on.
            let origin = capture
                .links
                .iter()
                .find(|l| l.rel == "up")
                .and_then(|l| l.href.rsplit_once("/authorizations/"))
                .ok_or(PayPalError::Malformed("capture"))?;
            if !matches!(capture.status.as_str(), "DECLINED" | "FAILED") {
                if capture.amount.currency_code != authorization.amount.currency_code {
                    return Err(PayPalError::Malformed("capture"));
                }
                let amount = minor(&capture.amount)?;
                order_captured = order_captured
                    .checked_add(amount)
                    .ok_or(PayPalError::Malformed("capture"))?;
                if origin.1 == authorization_id {
                    captured = captured
                        .checked_add(amount)
                        .ok_or(PayPalError::Malformed("capture"))?;
                }
                if let Some(request) = invoice_request(&capture.invoice_id) {
                    let sum: &mut i64 = captured_by_request.entry(request).or_default();
                    *sum = sum
                        .checked_add(amount)
                        .ok_or(PayPalError::Malformed("capture"))?;
                }
            }
        }
        let expires_at = OffsetDateTime::parse(
            &authorization.expiration_time,
            &time::format_description::well_known::Rfc3339,
        )
        .map_err(|_| PayPalError::Malformed("authorization"))?;
        Ok(PayPalObservation {
            order_id: order_id.clone(),
            authorization_id: authorization.id,
            status: authorization.status,
            authorized_minor: minor(&authorization.amount)?,
            currency: authorization.amount.currency_code,
            captured_minor: captured,
            order_captured_minor: order_captured,
            payee_merchant_id: authorization.payee.merchant_id,
            expires_at_ms: unix_ms(expires_at).ok_or(PayPalError::Malformed("authorization"))?,
            custom_id: authorization.custom_id,
            raw_authorization: Base64(raw_authorization),
            raw_order: Base64(raw_order),
            read_at_ms,
            captured_by_request,
        })
    }

    /// The request id a capture's `invoice_id`, `KS1-<request id>-<seq>-<digest>`, names.
    fn invoice_request(invoice_id: &str) -> Option<Ulid> {
        let (id, _) = invoice_id.strip_prefix("KS1-")?.split_once('-')?;
        Ulid::from_string(id).ok()
    }
}
