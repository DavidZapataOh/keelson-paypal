//! Keys derived from the KMS root: the credential issuer key, the per-user holder keys and the
//! sealing key.
//!
//! Each key is HKDF-SHA256 (RFC 5869) over the root with salt `keelson/kdf/v1` and its own
//! `info`. A P-256 key is the first 32-byte output for `info ‖ counter`, counter from 0, that is
//! a scalar in `[1, n)`.

use std::fmt;

use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{Aead, Generate, KeyInit, Nonce, Payload};
use hkdf::Hkdf;
use p256::ecdsa::SigningKey;
use sha2::Sha256;
use zeroize::{ZeroizeOnDrop, Zeroizing};

const KDF_SALT: &[u8] = b"keelson/kdf/v1";
const SEAL_VERSION: u8 = 1;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// A sealed blob that does not open under this root and `aad`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SealError;

impl fmt::Display for SealError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the sealed blob does not open")
    }
}

impl std::error::Error for SealError {}

/// The 32-byte root key from the KMS. It lives only in this process, boxed so moves never copy
/// it, and is zeroized on drop; there is no `Clone`, `Debug` or way to export it.
pub struct Root(Box<Zeroizing<[u8; 32]>>);

impl ZeroizeOnDrop for Root {}

impl Root {
    /// Copies the root key in; the caller wipes its own copy.
    pub fn new(key: &[u8; 32]) -> Self {
        let mut root = Box::new(Zeroizing::new([0; 32]));
        root.copy_from_slice(key);
        Self(root)
    }

    /// The key that signs user credentials (`info` = `issuer`).
    pub fn issuer_key(&self) -> SigningKey {
        self.signing_key(b"issuer", b"")
    }

    /// The holder key of the user `sub`, which signs their open mandates (`info` = `user/‖sub`).
    pub fn user_key(&self, sub: &str) -> SigningKey {
        self.signing_key(b"user/", sub.as_bytes())
    }

    /// AES-256-GCM under the sealing key (`info` = `seal`) with a random 96-bit nonce:
    /// `0x01 ‖ nonce ‖ ciphertext ‖ tag`.
    pub fn seal(&self, aad: &[u8], plaintext: &[u8]) -> Vec<u8> {
        let nonce = Nonce::<Aes256Gcm>::generate();
        let ciphertext = self
            .cipher()
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .expect("plaintext within the AES-GCM limit");
        let mut blob = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
        blob.push(SEAL_VERSION);
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&ciphertext);
        blob
    }

    /// Opens a blob from [`Root::seal`] sealed with the same `aad`.
    pub fn unseal(&self, aad: &[u8], blob: &[u8]) -> Result<Vec<u8>, SealError> {
        let Some((&SEAL_VERSION, rest)) = blob.split_first() else {
            return Err(SealError);
        };
        if rest.len() < NONCE_LEN + TAG_LEN {
            return Err(SealError);
        }
        let (nonce, ciphertext) = rest.split_at(NONCE_LEN);
        let nonce = Nonce::<Aes256Gcm>::try_from(nonce).map_err(|_| SealError)?;
        self.cipher()
            .decrypt(
                &nonce,
                Payload {
                    msg: ciphertext,
                    aad,
                },
            )
            .map_err(|_| SealError)
    }

    fn hkdf(&self) -> Hkdf<Sha256> {
        Hkdf::new(Some(KDF_SALT), &self.0[..])
    }

    fn cipher(&self) -> Aes256Gcm {
        let mut key = Zeroizing::new([0; 32]);
        self.hkdf()
            .expand(b"seal", &mut key[..])
            .expect("32 bytes is a valid HKDF-SHA256 length");
        Aes256Gcm::new_from_slice(&key[..]).expect("32-byte key")
    }

    fn signing_key(&self, label: &[u8], suffix: &[u8]) -> SigningKey {
        let hkdf = self.hkdf();
        first_scalar(|counter, okm| {
            hkdf.expand_multi_info(&[label, suffix, &[counter]], okm)
                .expect("32 bytes is a valid HKDF-SHA256 length");
        })
    }
}

/// The first candidate, counter from 0, that is a scalar in `[1, n)`. A candidate is rejected
/// with probability below 2^-32, so 256 of them never all fail.
fn first_scalar(mut candidate: impl FnMut(u8, &mut [u8])) -> SigningKey {
    let mut okm = Zeroizing::new([0; 32]);
    (0..=u8::MAX)
        .find_map(|counter| {
            candidate(counter, &mut okm[..]);
            SigningKey::from_slice(&okm[..]).ok()
        })
        .expect("a scalar within 256 candidates")
}

#[cfg(test)]
mod tests {
    use zeroize::ZeroizeOnDrop;

    use super::{Root, first_scalar};

    const P256_N: [u8; 32] = [
        0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63,
        0x25, 0x51,
    ];

    #[test]
    fn skips_candidates_outside_the_scalar_range() {
        let mut tried = Vec::new();
        let key = first_scalar(|counter, okm| {
            tried.push(counter);
            match counter {
                0 => okm.copy_from_slice(&P256_N),
                1 => okm.fill(0),
                2 => okm.fill(0xff),
                _ => okm.fill(7),
            }
        });
        assert_eq!(tried, [0, 1, 2, 3]);
        assert_eq!(key.to_bytes().as_slice(), [7; 32]);
    }

    #[test]
    fn root_is_zeroized_on_drop() {
        fn assert_zeroize_on_drop<T: ZeroizeOnDrop>() {}
        assert_zeroize_on_drop::<Root>();
    }
}
