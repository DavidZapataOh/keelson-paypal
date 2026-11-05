use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{Error, jcs};

/// Domain-separation tags for [`hash_object`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dst {
    Mandate,
    MandateChallenge,
    Cart,
    EvidenceItem,
    Eval,
    Alibi,
    Verdict,
}

impl Dst {
    /// The tag string hashed ahead of the payload.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Mandate => "keelson/mandate/v1",
            Self::MandateChallenge => "keelson/mandate-challenge/v1",
            Self::Cart => "keelson/cart/v1",
            Self::EvidenceItem => "keelson/evidence-item/v1",
            Self::Eval => "keelson/eval/v1",
            Self::Alibi => "keelson/alibi/v1",
            Self::Verdict => "keelson/verdict/v1",
        }
    }

    /// Looks up a tag by its string form.
    pub fn parse(tag: &str) -> Option<Self> {
        [
            Self::Mandate,
            Self::MandateChallenge,
            Self::Cart,
            Self::EvidenceItem,
            Self::Eval,
            Self::Alibi,
            Self::Verdict,
        ]
        .into_iter()
        .find(|dst| dst.as_str() == tag)
    }
}

/// Computes `SHA-256(utf8(dst) || 0x00 || utf8(JCS(value)))`.
pub fn hash_object(dst: Dst, value: &Value) -> Result<[u8; 32], Error> {
    let mut hasher = Sha256::new();
    hasher.update(dst.as_str().as_bytes());
    hasher.update([0u8]);
    hasher.update(jcs(value)?.as_bytes());
    Ok(hasher.finalize().into())
}
