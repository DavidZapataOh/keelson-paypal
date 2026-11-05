use keelson_core::{AcirField, Dst, hash_object};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{Error, Fr};

/// `H_sd = H("keelson/mandate/v1", payload_SD)`: the payload with its `_sd` digests, without
/// disclosures.
pub fn h_sd(payload_sd: &Value) -> Result<[u8; 32], Error> {
    Ok(hash_object(Dst::Mandate, payload_sd)?)
}

/// The passkey challenge `M = SHA-256("keelson/mandate-challenge/v1" || 0x00 || H_sd || C_m)`,
/// with `C_m` as 32 bytes big-endian.
pub fn mandate_challenge(h_sd: &[u8; 32], cm: &Fr) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(Dst::MandateChallenge.as_str().as_bytes());
    hasher.update([0u8]);
    hasher.update(h_sd);
    hasher.update(cm.to_be_bytes());
    hasher.finalize().into()
}
