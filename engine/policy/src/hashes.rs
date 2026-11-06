use std::sync::OnceLock;

use sha2::{Digest, Sha256};

use crate::{POLICY_SET_SRC, SCHEMA_SRC};

/// SHA-256 of the policy set file bytes.
pub fn policy_set_hash() -> [u8; 32] {
    Sha256::digest(POLICY_SET_SRC).into()
}

/// SHA-256 of the schema file bytes.
pub fn schema_hash() -> [u8; 32] {
    Sha256::digest(SCHEMA_SRC).into()
}

/// [`policy_set_hash`] as `sha256:<hex>`.
pub fn policy_set_hash_tag() -> String {
    static TAG: OnceLock<String> = OnceLock::new();
    TAG.get_or_init(|| tag(&policy_set_hash())).clone()
}

/// [`schema_hash`] as `sha256:<hex>`.
pub fn schema_hash_tag() -> String {
    static TAG: OnceLock<String> = OnceLock::new();
    TAG.get_or_init(|| tag(&schema_hash())).clone()
}

fn tag(digest: &[u8; 32]) -> String {
    hex("sha256:", digest)
}

/// `prefix` followed by `bytes` in lowercase hex.
pub(crate) fn hex(prefix: &str, bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(prefix.len() + bytes.len() * 2);
    s.push_str(prefix);
    for &b in bytes {
        s.push(char::from(DIGITS[usize::from(b >> 4)]));
        s.push(char::from(DIGITS[usize::from(b & 0xf)]));
    }
    s
}
