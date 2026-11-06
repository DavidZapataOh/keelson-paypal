//! The countersign key: generated in RAM at boot, never serialized, zeroized on drop.

use std::fmt;

use alloy_primitives::Address;
use k256::ecdsa::SigningKey;
use k256::elliptic_curve::Generate;

/// A secp256k1 key that exists only in this process.
///
/// `SigningKey` zeroizes its scalar on drop; there is no `Clone` and no way to export it.
pub struct Signer {
    key: SigningKey,
}

impl Signer {
    /// Generates a key from the OS RNG.
    pub fn generate() -> Self {
        Self {
            key: SigningKey::generate(),
        }
    }

    #[cfg(test)]
    fn from_test_key(bytes: &[u8; 32]) -> Self {
        Self {
            key: SigningKey::from_slice(bytes).expect("valid test key"),
        }
    }

    /// The Ethereum address of the key.
    pub fn address(&self) -> Address {
        Address::from_raw_public_key(&self.public_key_sec1()[1..])
    }

    /// The uncompressed SEC1 public key (`0x04 ‖ x ‖ y`).
    pub fn public_key_sec1(&self) -> [u8; 65] {
        let point = self.key.verifying_key().to_sec1_point(false);
        point
            .as_bytes()
            .try_into()
            .expect("uncompressed SEC1 point")
    }

    /// Signs a 32-byte digest with RFC 6979: `r ‖ s ‖ v`, low-S, `v ∈ {27, 28}`.
    pub fn sign_digest(&self, digest: &[u8; 32]) -> [u8; 65] {
        // k256 normalizes to low-S and flips the recovery id accordingly.
        let (signature, recovery_id) = self.key.sign_prehash_recoverable(digest);
        let mut out = [0; 65];
        out[..64].copy_from_slice(&signature.to_bytes());
        out[64] = 27 + recovery_id.to_byte();
        out
    }
}

impl fmt::Debug for Signer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Signer")
            .field("address", &self.address())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use k256::elliptic_curve::zeroize::ZeroizeOnDrop;
    use serde_json::Value;

    use super::Signer;

    fn bytes<const N: usize>(v: &Value) -> [u8; N] {
        let s = v.as_str().unwrap().strip_prefix("0x").unwrap();
        let out: Vec<u8> = (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect();
        out.try_into().unwrap()
    }

    #[test]
    fn signs_countersign_vectors_like_viem() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../packages/core/test/vectors/countersign.json"
        ))
        .unwrap();
        assert_eq!(vectors.len(), 20);
        for v in vectors {
            let signer = Signer::from_test_key(&bytes(&v["input"]["privateKey"]));
            let signature = signer.sign_digest(&bytes(&v["expected"]["digest"]));
            assert_eq!(
                signature,
                bytes::<65>(&v["expected"]["signature"]),
                "{}",
                v["name"]
            );
        }
    }

    #[test]
    fn key_is_zeroized_on_drop() {
        fn assert_zeroize_on_drop<T: ZeroizeOnDrop>() {}
        assert_zeroize_on_drop::<k256::ecdsa::SigningKey>();
    }

    #[test]
    fn debug_shows_only_the_address() {
        let signer = Signer::generate();
        let debug = format!("{signer:?}");
        assert_eq!(
            debug,
            format!("Signer {{ address: {:?}, .. }}", signer.address())
        );
    }
}
