use std::fmt;

use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::b64;
use crate::spc::{SPC_INSTRUMENT_DISPLAY_NAME, SPC_INSTRUMENT_ICON, SpcDetails};

const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_BE: u8 = 0x08;
const FLAG_BS: u8 = 0x10;
const FLAG_AT: u8 = 0x40;
const FLAG_ED: u8 = 0x80;

/// Authenticator data without attested credential data or extensions: `rpIdHash`, flags and
/// the signature counter (WebAuthn section 6.1).
const AUTH_DATA_LEN: usize = 37;

/// Upper bounds on the decoded inputs, far above what a browser produces.
pub const MAX_CLIENT_DATA_JSON: usize = 4096;
pub const MAX_AUTHENTICATOR_DATA: usize = 1024;
pub const MAX_SIGNATURE: usize = 80;

/// A passkey assertion as the browser returns it, every field base64url without padding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assertion {
    pub authenticator_data: String,
    pub client_data_json: String,
    pub signature: String,
}

/// What the assertion must match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expected {
    /// The mandate challenge `M`.
    pub challenge: [u8; 32],
    /// The origin the page that signed is served from.
    pub origin: String,
    pub rp_id: String,
    /// The passkey's P-256 public key, SEC1 uncompressed (`0x04 || x || y`).
    pub public_key_sec1: Vec<u8>,
    /// What the SPC dialog must have shown, from [`crate::spc_details`].
    pub spc: SpcDetails,
}

/// The check an assertion failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebAuthnError {
    /// `clientDataJSON` is not base64url-encoded UTF-8 JSON, is not an object or is too large.
    ClientData,
    /// `type` is neither `webauthn.get` nor `payment.get`.
    Type,
    Challenge,
    Origin,
    /// The assertion was made in a cross-origin iframe: `crossOrigin` is other than `false`,
    /// or `topOrigin` is present.
    CrossOrigin,
    /// `tokenBinding` is present; no Keelson client uses token binding.
    TokenBinding,
    /// A `payment` member of SPC client data differs from what the mandate shows.
    Payment(&'static str),
    /// `authenticatorData` is not exactly `rpIdHash`, flags and counter: it carries attested
    /// credential data or extensions, which Keelson never requests, or is truncated.
    AuthenticatorData,
    /// `rpIdHash` is not SHA-256 of the expected RP ID.
    RpId,
    UserPresent,
    UserVerified,
    /// The backup state flag is set on a credential that is not backup eligible.
    BackupState,
    /// The expected public key is not an uncompressed P-256 point.
    PublicKey,
    /// The signature is not DER, is too large or does not verify.
    Signature,
}

impl fmt::Display for WebAuthnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ClientData => f.write_str("clientDataJSON is not a JSON object"),
            Self::Type => f.write_str("unexpected client data type"),
            Self::Challenge => f.write_str("unexpected challenge"),
            Self::Origin => f.write_str("unexpected origin"),
            Self::CrossOrigin => f.write_str("cross-origin assertion"),
            Self::TokenBinding => f.write_str("token binding is not supported"),
            Self::Payment(field) => write!(f, "payment.{field} differs from the mandate"),
            Self::AuthenticatorData => f.write_str("authenticatorData is not 37 bytes"),
            Self::RpId => f.write_str("unexpected RP ID hash"),
            Self::UserPresent => f.write_str("user not present"),
            Self::UserVerified => f.write_str("user not verified"),
            Self::BackupState => f.write_str("backed up but not backup eligible"),
            Self::PublicKey => f.write_str("public key is not an uncompressed P-256 point"),
            Self::Signature => f.write_str("signature does not verify"),
        }
    }
}

impl std::error::Error for WebAuthnError {}

/// Verifies a passkey assertion over `expected.challenge` (WebAuthn Level 3 section 7.2, with
/// the changes of Secure Payment Confirmation section 9.1 for `payment.get`). User presence and
/// user verification are required; cross-origin assertions, token binding, attested credential
/// data and extensions are refused; the ES256 signature is ASN.1 DER. The signature counter is
/// left to the caller, which holds the stored value.
pub fn verify_assertion(a: &Assertion, expected: &Expected) -> Result<(), WebAuthnError> {
    let client_data_json = decode_bounded(&a.client_data_json, MAX_CLIENT_DATA_JSON)
        .ok_or(WebAuthnError::ClientData)?;
    check_client_data(&client_data_json, expected)?;

    let auth_data = decode_bounded(&a.authenticator_data, MAX_AUTHENTICATOR_DATA)
        .filter(|d| d.len() == AUTH_DATA_LEN && d[32] & (FLAG_AT | FLAG_ED) == 0)
        .ok_or(WebAuthnError::AuthenticatorData)?;
    let flags = auth_data[32];
    if auth_data[..32] != Sha256::digest(expected.rp_id.as_bytes())[..] {
        return Err(WebAuthnError::RpId);
    }
    if flags & FLAG_UP == 0 {
        return Err(WebAuthnError::UserPresent);
    }
    if flags & FLAG_UV == 0 {
        return Err(WebAuthnError::UserVerified);
    }
    if flags & FLAG_BS != 0 && flags & FLAG_BE == 0 {
        return Err(WebAuthnError::BackupState);
    }

    let key = match expected.public_key_sec1.first() {
        Some(0x04) => VerifyingKey::from_sec1_bytes(&expected.public_key_sec1).ok(),
        _ => None,
    }
    .ok_or(WebAuthnError::PublicKey)?;
    let signature = decode_bounded(&a.signature, MAX_SIGNATURE)
        .and_then(|der| Signature::from_der(&der).ok())
        .ok_or(WebAuthnError::Signature)?;
    let signed = [&auth_data[..], &Sha256::digest(&client_data_json)].concat();
    key.verify(&signed, &signature)
        .map_err(|_| WebAuthnError::Signature)
}

/// Decodes base64url of at most `max` bytes, refusing longer input before decoding it.
fn decode_bounded(s: &str, max: usize) -> Option<Vec<u8>> {
    if s.len() > max.div_ceil(3) * 4 {
        return None;
    }
    b64::decode(s).filter(|bytes| bytes.len() <= max)
}

fn check_client_data(bytes: &[u8], expected: &Expected) -> Result<(), WebAuthnError> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let c: Value = serde_json::from_slice(bytes).map_err(|_| WebAuthnError::ClientData)?;
    let Value::Object(c) = c else {
        return Err(WebAuthnError::ClientData);
    };
    let is_payment = match c.get("type").and_then(Value::as_str) {
        Some("webauthn.get") => false,
        Some("payment.get") => true,
        _ => return Err(WebAuthnError::Type),
    };
    let challenge = b64::encode(&expected.challenge);
    if c.get("challenge").and_then(Value::as_str) != Some(challenge.as_str()) {
        return Err(WebAuthnError::Challenge);
    }
    if c.get("origin").and_then(Value::as_str) != Some(expected.origin.as_str()) {
        return Err(WebAuthnError::Origin);
    }
    let cross_origin = c.get("crossOrigin").is_some_and(|v| v != false);
    if cross_origin || c.get("topOrigin").is_some() {
        return Err(WebAuthnError::CrossOrigin);
    }
    if c.contains_key("tokenBinding") {
        return Err(WebAuthnError::TokenBinding);
    }
    if is_payment {
        check_payment(c.get("payment").unwrap_or(&Value::Null), expected)?;
    }
    Ok(())
}

fn check_payment(p: &Value, expected: &Expected) -> Result<(), WebAuthnError> {
    let spc = &expected.spc;
    let checks: [(&'static str, &Value, &str); 8] = [
        ("rpId", &p["rpId"], &expected.rp_id),
        ("topOrigin", &p["topOrigin"], &expected.origin),
        ("payeeName", &p["payeeName"], &spc.payee_name),
        ("payeeOrigin", &p["payeeOrigin"], &spc.payee_origin),
        ("total.currency", &p["total"]["currency"], &spc.currency),
        ("total.value", &p["total"]["value"], &spc.value),
        (
            "instrument.displayName",
            &p["instrument"]["displayName"],
            SPC_INSTRUMENT_DISPLAY_NAME,
        ),
        (
            "instrument.icon",
            &p["instrument"]["icon"],
            SPC_INSTRUMENT_ICON,
        ),
    ];
    if let Some((field, ..)) = checks
        .iter()
        .find(|(_, got, want)| got.as_str() != Some(want))
    {
        return Err(WebAuthnError::Payment(field));
    }
    // No logos are shown, so none may be reported (SPC section 9.1).
    match p.get("paymentEntitiesLogos") {
        None => Ok(()),
        Some(Value::Array(logos)) if logos.is_empty() => Ok(()),
        Some(_) => Err(WebAuthnError::Payment("paymentEntitiesLogos")),
    }
}
