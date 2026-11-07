//! Keys derived from the KMS root: the credential issuer key, the per-user holder keys and the
//! sealing key.
//!
//! Each key is HKDF-SHA256 (RFC 5869) over the root with salt `keelson/kdf/v1` and its own
//! `info`. A P-256 key is the first 32-byte output for `info ‖ counter`, counter from 0, that is
//! a scalar in `[1, n)`.

use std::fmt;

use aes_gcm::Aes256Gcm;
use aes_gcm::aead::{Aead, Generate, KeyInit, Nonce, Payload};
use hkdf::{Hkdf, HkdfExtract};
use p256::ecdsa::SigningKey;
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

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

/// What a sealed blob is bound to. One sealing key covers every purpose, so each blob opens only
/// for the purpose, the user and the record it was sealed for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SealAad<'a> {
    /// A versioned label such as `keelson/seal/mandate-salt/v1`.
    pub purpose: &'a str,
    /// The user the record belongs to, for per-user records.
    pub sub: Option<&'a str>,
    /// The id of the sealed record.
    pub record: &'a [u8],
}

impl SealAad<'_> {
    /// `len(purpose) ‖ purpose ‖ (0x00 | 0x01 ‖ len(sub) ‖ sub) ‖ record`, lengths as `u32`
    /// big-endian, so no two contexts share an encoding.
    fn encode(&self) -> Vec<u8> {
        fn put(out: &mut Vec<u8>, bytes: &[u8]) {
            let len = u32::try_from(bytes.len()).expect("AAD parts shorter than 4 GiB");
            out.extend_from_slice(&len.to_be_bytes());
            out.extend_from_slice(bytes);
        }
        let mut out = Vec::with_capacity(16 + self.purpose.len() + self.record.len());
        put(&mut out, self.purpose.as_bytes());
        match self.sub {
            None => out.push(0),
            Some(sub) => {
                out.push(1);
                put(&mut out, sub.as_bytes());
            }
        }
        out.extend_from_slice(self.record);
        out
    }
}

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

    /// AES-256-GCM under the sealing key (`info` = `seal`) with a random 96-bit nonce and `aad`
    /// as the associated data: `0x01 ‖ nonce ‖ ciphertext ‖ tag`.
    pub fn seal(&self, aad: &SealAad<'_>, plaintext: &[u8]) -> Vec<u8> {
        let nonce = Nonce::<Aes256Gcm>::generate();
        let ciphertext = self
            .cipher()
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad: &aad.encode(),
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
    pub fn unseal(&self, aad: &SealAad<'_>, blob: &[u8]) -> Result<Vec<u8>, SealError> {
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
                    aad: &aad.encode(),
                },
            )
            .map_err(|_| SealError)
    }

    fn hkdf(&self) -> Hkdf<Sha256> {
        // `Hkdf::new` drops the pseudorandom key unwiped, and every derived key follows from it.
        let mut extract = HkdfExtract::<Sha256>::new(Some(KDF_SALT));
        extract.input_ikm(&self.0[..]);
        let (mut prk, hkdf) = extract.finalize();
        prk.zeroize();
        hkdf
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

    #[test]
    fn hkdf_hmac_states_are_zeroized_on_drop() {
        fn assert_zeroize_on_drop<T: ZeroizeOnDrop>() {}
        // HMAC keeps its keyed inner and outer states as `<Sha256 as EagerHash>::Core`.
        assert_zeroize_on_drop::<<sha2::Sha256 as sha2::digest::block_api::EagerHash>::Core>();
    }

    #[test]
    fn the_root_bytes_are_zero_after_drop() {
        let Root(inner) = Root::new(&[0xa5; 32]);
        let raw = Box::into_raw(inner);
        // SAFETY: `raw` comes from `Box::into_raw`, so it is valid and aligned. `drop_in_place`
        // runs the destructor once; the allocation stays live until `dealloc`, which does not
        // run the destructor again.
        let after = unsafe {
            std::ptr::drop_in_place(raw);
            let after: [u8; 32] = **raw;
            std::alloc::dealloc(
                raw.cast(),
                std::alloc::Layout::new::<zeroize::Zeroizing<[u8; 32]>>(),
            );
            after
        };
        assert_eq!(after, [0; 32]);
    }
}
