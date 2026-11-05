use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::general_purpose::{GeneralPurpose, NO_PAD};
use serde_json::Value;

/// Unpadded base64url (RFC 4648 section 5) that, like most JOSE libraries, tolerates non-zero
/// pad bits when decoding.
const LENIENT: GeneralPurpose =
    GeneralPurpose::new(&URL_SAFE, NO_PAD.with_decode_allow_trailing_bits(true));

pub(crate) fn encode(bytes: &[u8]) -> String {
    LENIENT.encode(bytes)
}

pub(crate) fn decode(s: &str) -> Option<Vec<u8>> {
    LENIENT.decode(s).ok()
}

/// Decodes the canonical encoding only: no padding and zero pad bits.
pub(crate) fn decode_canonical(s: &str) -> Option<Vec<u8>> {
    decode(s).filter(|bytes| encode(bytes) == s)
}

/// Decodes base64url-encoded UTF-8 JSON, rejecting invalid UTF-8, lone surrogates and values
/// that fail [`crate::strict::check`].
pub(crate) fn decode_json(s: &str) -> Option<Value> {
    let value = serde_json::from_str(std::str::from_utf8(&decode(s)?).ok()?).ok()?;
    crate::strict::check(&value).ok().map(|()| value)
}

pub(crate) fn is_base64url(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
