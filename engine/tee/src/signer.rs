//! The countersign key: generated in RAM at boot, never serialized, zeroized on drop.

use alloy_primitives::Address;
use alloy_sol_types::Eip712Domain;
use alloy_sol_types::SolStruct;
use k256::ecdsa::{RecoveryId, SigningKey};
use k256::elliptic_curve::Generate;
use k256::elliptic_curve::zeroize::ZeroizeOnDrop;
use keelson_core::eip712::{CardAuthorization, Checkpoint, Countersign, Verdict, WebFact};

use sha2::Digest as _;

use crate::countersign_digest;
use crate::error::{Error, check_chain};

/// A secp256k1 key that exists only in this process.
///
/// The key is boxed so moving a `Signer` never copies the scalar; `SigningKey` zeroizes it on
/// drop. There is no `Clone` and no way to export it, and it only signs `Countersign` and
/// `Checkpoint` payloads.
pub struct Signer {
    key: Box<SigningKey>,
}

impl ZeroizeOnDrop for Signer {}

impl Signer {
    /// Generates a key from the OS RNG.
    pub fn generate() -> Self {
        Self {
            key: Box::new(SigningKey::generate()),
        }
    }

    #[cfg(test)]
    fn from_test_key(bytes: &[u8; 32]) -> Self {
        Self {
            key: Box::new(SigningKey::from_slice(bytes).expect("valid test key")),
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

    /// Signs the EIP-712 digest of `c`: `r ‖ s ‖ v`, RFC 6979, low-S, `v ∈ {27, 28}`.
    ///
    /// Fails on domains outside Arbitrum Sepolia and Arbitrum One.
    pub fn sign_countersign(
        &self,
        c: &Countersign,
        domain: &Eip712Domain,
    ) -> Result<[u8; 65], Error> {
        let chain_id = domain
            .chain_id
            .and_then(|id| u64::try_from(id).ok())
            .ok_or(Error::MissingChain)?;
        check_chain(chain_id)?;
        self.sign_digest(&countersign_digest(c, domain))
    }

    /// Signs the EIP-712 digest of `c`, as [`Signer::sign_countersign`] does.
    ///
    /// Fails on domains outside Arbitrum Sepolia and Arbitrum One.
    pub fn sign_checkpoint(
        &self,
        c: &Checkpoint,
        domain: &Eip712Domain,
    ) -> Result<[u8; 65], Error> {
        let chain_id = domain
            .chain_id
            .and_then(|id| u64::try_from(id).ok())
            .ok_or(Error::MissingChain)?;
        check_chain(chain_id)?;
        self.sign_digest(&c.eip712_signing_hash(domain).0)
    }

    /// Signs the EIP-712 digest of `v`, as [`Signer::sign_countersign`] does.
    ///
    /// Fails on domains outside Arbitrum Sepolia and Arbitrum One.
    pub fn sign_verdict(&self, v: &Verdict, domain: &Eip712Domain) -> Result<[u8; 65], Error> {
        let chain_id = domain
            .chain_id
            .and_then(|id| u64::try_from(id).ok())
            .ok_or(Error::MissingChain)?;
        check_chain(chain_id)?;
        self.sign_digest(&v.eip712_signing_hash(domain).0)
    }

    /// Signs the EIP-712 digest of `f`, as [`Signer::sign_countersign`] does.
    ///
    /// Fails on domains outside Arbitrum Sepolia and Arbitrum One.
    pub fn sign_web_fact(&self, f: &WebFact, domain: &Eip712Domain) -> Result<[u8; 65], Error> {
        let chain_id = domain
            .chain_id
            .and_then(|id| u64::try_from(id).ok())
            .ok_or(Error::MissingChain)?;
        check_chain(chain_id)?;
        self.sign_digest(&f.eip712_signing_hash(domain).0)
    }

    /// Signs the EIP-712 digest of `a`, as [`Signer::sign_countersign`] does.
    ///
    /// Fails on domains outside Arbitrum Sepolia and Arbitrum One.
    pub fn sign_card_authorization(
        &self,
        a: &CardAuthorization,
        domain: &Eip712Domain,
    ) -> Result<[u8; 65], Error> {
        let chain_id = domain
            .chain_id
            .and_then(|id| u64::try_from(id).ok())
            .ok_or(Error::MissingChain)?;
        check_chain(chain_id)?;
        self.sign_digest(&a.eip712_signing_hash(domain).0)
    }

    /// Whether `signature` (`r ‖ s ‖ v`) is this key's signature over `digest`.
    pub fn signed(&self, digest: &[u8; 32], signature: &[u8; 65]) -> bool {
        use k256::ecdsa::signature::hazmat::PrehashVerifier;
        k256::ecdsa::Signature::from_slice(&signature[..64])
            .is_ok_and(|s| self.key.verifying_key().verify_prehash(digest, &s).is_ok())
    }

    /// Signs the binding of an RA-TLS certificate, a digest no EIP-712 message can have.
    pub fn sign_tls_binding(&self, digest: &[u8; 32]) -> Result<[u8; 65], Error> {
        self.sign_digest(digest)
    }

    /// Signs an EIP-712 digest the caller computed from a Keelson type.
    pub fn sign_digest_of(&self, digest: &[u8; 32]) -> Result<[u8; 65], Error> {
        self.sign_digest(digest)
    }

    /// Signs a COSE `Sig_structure` with ES256K (RFC 8812): SHA-256, low-S, `r ‖ s`.
    pub fn sign_statement(&self, to_be_signed: &[u8]) -> Result<[u8; 64], Error> {
        let digest: [u8; 32] = sha2::Sha256::digest(to_be_signed).into();
        let full = self.sign_digest(&digest)?;
        let mut out = [0; 64];
        out.copy_from_slice(&full[..64]);
        Ok(out)
    }

    fn sign_digest(&self, digest: &[u8; 32]) -> Result<[u8; 65], Error> {
        // k256 normalizes to low-S and flips the recovery id accordingly.
        let (signature, recovery_id) = self.key.sign_prehash_recoverable(digest);
        let mut out = [0; 65];
        out[..64].copy_from_slice(&signature.to_bytes());
        out[64] = v_byte(recovery_id)?;
        Ok(out)
    }
}

/// Recovery ids 2 and 3 (x-reduced `R`) have no Ethereum `v`.
fn v_byte(recovery_id: RecoveryId) -> Result<u8, Error> {
    match recovery_id.to_byte() {
        id @ (0 | 1) => Ok(27 + id),
        _ => Err(Error::UnusableSignature),
    }
}

/// The address that signed `digest` with a 65-byte `r ‖ s ‖ v`, refusing a high `s`.
pub fn recover_address(digest: &[u8; 32], signature: &[u8; 65]) -> Option<Address> {
    let sig = k256::ecdsa::Signature::from_slice(&signature[..64]).ok()?;
    if sig.normalize_s() != sig {
        return None;
    }
    let id = match signature[64] {
        v @ (0 | 1) => v,
        v @ (27 | 28) => v - 27,
        _ => return None,
    };
    let key =
        k256::ecdsa::VerifyingKey::recover_from_prehash(digest, &sig, RecoveryId::from_byte(id)?)
            .ok()?;
    Some(Address::from_raw_public_key(
        &key.to_sec1_point(false).as_bytes()[1..],
    ))
}

#[cfg(test)]
mod tests {
    use k256::ecdsa::RecoveryId;
    use k256::elliptic_curve::zeroize::ZeroizeOnDrop;
    use serde_json::Value;

    use super::{Signer, v_byte};
    use crate::Error;

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
            let signature = signer
                .sign_digest(&bytes(&v["expected"]["digest"]))
                .unwrap();
            assert_eq!(
                signature,
                bytes::<65>(&v["expected"]["signature"]),
                "{}",
                v["name"]
            );
        }
    }

    #[test]
    fn signer_is_zeroized_on_drop() {
        fn assert_zeroize_on_drop<T: ZeroizeOnDrop>() {}
        assert_zeroize_on_drop::<Signer>();
    }

    #[test]
    fn rejects_recovery_ids_ethereum_cannot_express() {
        assert_eq!(v_byte(RecoveryId::from_byte(0).unwrap()), Ok(27));
        assert_eq!(v_byte(RecoveryId::from_byte(1).unwrap()), Ok(28));
        for id in [2, 3] {
            assert_eq!(
                v_byte(RecoveryId::from_byte(id).unwrap()),
                Err(Error::UnusableSignature)
            );
        }
    }

    #[test]
    fn the_scalar_is_overwritten_on_drop() {
        let secret = [0x5a; 32];
        let Signer { key } = Signer::from_test_key(&secret);
        let raw = Box::into_raw(key);
        // SAFETY: `raw` comes from `Box::into_raw`, so it is valid and aligned. `drop_in_place`
        // runs the destructor once; the allocation stays live until `dealloc`, which does not
        // run the destructor again.
        let after = unsafe {
            std::ptr::drop_in_place(raw);
            let after = (*raw).to_bytes();
            std::alloc::dealloc(
                raw.cast(),
                std::alloc::Layout::new::<k256::ecdsa::SigningKey>(),
            );
            after
        };
        // A zeroized NonZeroScalar holds one, to keep its non-zero invariant.
        let mut one = [0; 32];
        one[31] = 1;
        assert_eq!(after.as_slice(), one);
    }
}
