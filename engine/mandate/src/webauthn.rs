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

/// Deepest nesting accepted in the CBOR of authenticator extension outputs.
const MAX_CBOR_DEPTH: usize = 16;

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
    /// The passkey's P-256 public key, SEC1-encoded.
    pub public_key_sec1: Vec<u8>,
    /// What the SPC dialog must have shown, from [`crate::spc_details`].
    pub spc: SpcDetails,
}

/// The check an assertion failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebAuthnError {
    /// `clientDataJSON` is not base64url-encoded UTF-8 JSON.
    ClientData,
    /// `type` is neither `webauthn.get` nor `payment.get`.
    Type,
    Challenge,
    Origin,
    /// The assertion was made in a cross-origin iframe.
    CrossOrigin,
    /// A `payment` member of SPC client data differs from what the mandate shows.
    Payment(&'static str),
    /// `authenticatorData` is malformed.
    AuthenticatorData,
    /// `rpIdHash` is not SHA-256 of the expected RP ID.
    RpId,
    UserPresent,
    UserVerified,
    /// The backup state flag is set on a credential that is not backup eligible.
    BackupState,
    /// The expected public key is not a P-256 point.
    PublicKey,
    Signature,
}

impl fmt::Display for WebAuthnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ClientData => f.write_str("clientDataJSON is not base64url JSON"),
            Self::Type => f.write_str("unexpected client data type"),
            Self::Challenge => f.write_str("unexpected challenge"),
            Self::Origin => f.write_str("unexpected origin"),
            Self::CrossOrigin => f.write_str("cross-origin assertion"),
            Self::Payment(field) => write!(f, "payment.{field} differs from the mandate"),
            Self::AuthenticatorData => f.write_str("malformed authenticator data"),
            Self::RpId => f.write_str("unexpected RP ID hash"),
            Self::UserPresent => f.write_str("user not present"),
            Self::UserVerified => f.write_str("user not verified"),
            Self::BackupState => f.write_str("backed up but not backup eligible"),
            Self::PublicKey => f.write_str("public key is not a P-256 point"),
            Self::Signature => f.write_str("signature does not verify"),
        }
    }
}

impl std::error::Error for WebAuthnError {}

/// Verifies a passkey assertion over `expected.challenge` (WebAuthn Level 3 section 7.2, with
/// the changes of Secure Payment Confirmation section 9.1 for `payment.get`). User presence and
/// user verification are required, cross-origin assertions are refused, and the ES256 signature
/// is ASN.1 DER. The signature counter is left to the caller, which holds the stored value.
pub fn verify_assertion(a: &Assertion, expected: &Expected) -> Result<(), WebAuthnError> {
    let client_data_json = b64::decode(&a.client_data_json).ok_or(WebAuthnError::ClientData)?;
    check_client_data(&client_data_json, expected)?;

    let auth_data = b64::decode(&a.authenticator_data).ok_or(WebAuthnError::AuthenticatorData)?;
    let flags = check_authenticator_data(&auth_data)?;
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

    let key = VerifyingKey::from_sec1_bytes(&expected.public_key_sec1)
        .map_err(|_| WebAuthnError::PublicKey)?;
    let signature = b64::decode(&a.signature)
        .and_then(|der| Signature::from_der(&der).ok())
        .ok_or(WebAuthnError::Signature)?;
    let signed = [&auth_data[..], &Sha256::digest(&client_data_json)].concat();
    key.verify(&signed, &signature)
        .map_err(|_| WebAuthnError::Signature)
}

fn check_client_data(bytes: &[u8], expected: &Expected) -> Result<(), WebAuthnError> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let c: Value = serde_json::from_slice(bytes).map_err(|_| WebAuthnError::ClientData)?;
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
    if is_payment {
        check_payment(&c["payment"], expected)?;
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
    match checks
        .iter()
        .find(|(_, got, want)| got.as_str() != Some(want))
    {
        Some((field, ..)) => Err(WebAuthnError::Payment(field)),
        None => Ok(()),
    }
}

/// Checks the layout of `authenticatorData` (WebAuthn section 6.1) and returns its flags. An
/// assertion carries no attested credential data; extension outputs must be one well-formed
/// CBOR item with nothing after it.
fn check_authenticator_data(d: &[u8]) -> Result<u8, WebAuthnError> {
    let malformed = WebAuthnError::AuthenticatorData;
    if d.len() < 37 {
        return Err(malformed);
    }
    let flags = d[32];
    let mut pos = 37;
    if flags & FLAG_AT != 0 {
        return Err(malformed);
    }
    if flags & FLAG_ED != 0 {
        skip_cbor(d, &mut pos, 0).ok_or(malformed)?;
    }
    if pos != d.len() {
        return Err(malformed);
    }
    Ok(flags)
}

/// Advances `pos` past one definite-length CBOR data item (RFC 8949).
fn skip_cbor(d: &[u8], pos: &mut usize, depth: usize) -> Option<()> {
    if depth > MAX_CBOR_DEPTH {
        return None;
    }
    let initial = *d.get(*pos)?;
    *pos += 1;
    let (major, info) = (initial >> 5, initial & 0x1f);
    let arg = match info {
        0..=23 => u64::from(info),
        24..=27 => {
            let len = 1usize << (info - 24);
            let bytes = d.get(*pos..*pos + len)?;
            *pos += len;
            bytes.iter().fold(0, |n, &b| n << 8 | u64::from(b))
        }
        _ => return None,
    };
    let remaining = (d.len() - *pos) as u64;
    match major {
        0 | 1 | 7 => Some(()),
        2 | 3 if arg <= remaining => {
            *pos += arg as usize;
            Some(())
        }
        4 | 5 if arg <= remaining => {
            let items = if major == 5 { arg * 2 } else { arg };
            (0..items).try_for_each(|_| skip_cbor(d, pos, depth + 1))
        }
        6 => skip_cbor(d, pos, depth + 1),
        _ => None,
    }
}
