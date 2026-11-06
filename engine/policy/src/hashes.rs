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
    tag(&policy_set_hash())
}

/// [`schema_hash`] as `sha256:<hex>`.
pub fn schema_hash_tag() -> String {
    tag(&schema_hash())
}

fn tag(digest: &[u8; 32]) -> String {
    let mut s = String::with_capacity(71);
    s.push_str("sha256:");
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}
