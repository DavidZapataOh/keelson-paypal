//! The dstack KMS signature chain of a `GetKey` key (dstack `docs/guest-api-v1.md`, "The
//! signature chain"): proof that the KMS issued the key to leg A's app, which only a CVM running
//! an allowed compose of that app can obtain.

use alloy_primitives::keccak256;
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

/// Leg A's dstack app id (`phala/app.json`).
pub const APP_ID: [u8; 20] = [
    0x58, 0x95, 0x5b, 0xaa, 0xc3, 0x07, 0x2b, 0xac, 0x57, 0x06, 0x40, 0x89, 0x17, 0x6b, 0xed, 0x1c,
    0x23, 0x79, 0xf8, 0x6d,
];

/// The secp256k1 root key of the KMS leg A's app takes its keys from (`kms_info.k256_pubkey` of
/// the CVM in Phala Cloud), SEC1 compressed.
pub const KMS_ROOT: [u8; 33] = [
    0x02, 0x21, 0x79, 0x7a, 0x50, 0x7c, 0x42, 0x40, 0xf3, 0x18, 0xde, 0xde, 0x48, 0x29, 0xd0, 0xa2,
    0xf8, 0x4d, 0x01, 0x33, 0x1e, 0x82, 0xf3, 0xf4, 0x3c, 0x8f, 0x57, 0x46, 0x45, 0x1c, 0x9d, 0x5e,
    0x20,
];

fn lp(out: &mut Vec<u8>, field: &[u8]) {
    out.extend_from_slice(&u32::try_from(field.len()).unwrap_or(u32::MAX).to_be_bytes());
    out.extend_from_slice(field);
}

/// Recovers the signer of a 65-byte `r ‖ s ‖ v` over `digest`, refusing a high `s`.
fn recover(digest: &[u8; 32], link: &[u8]) -> Option<VerifyingKey> {
    let (rs, v) = link.split_at_checked(64)?;
    let signature = Signature::from_slice(rs).ok()?;
    if signature.normalize_s() != signature {
        return None;
    }
    let id = match *v.first()? {
        v @ (0 | 1) => v,
        v @ (27 | 28) => v - 27,
        _ => return None,
    };
    let id = RecoveryId::from_byte(id)?;
    VerifyingKey::recover_from_prehash(digest, &signature, id).ok()
}

/// Whether `chain` proves the KMS rooted at `kms_root` issued `public_key` to app `app_id`
/// under `(domain, algorithm)`.
pub fn verify_chain(
    algorithm: &str,
    domain: &str,
    public_key: &[u8],
    chain: &[Vec<u8>],
    app_id: &[u8],
    kms_root: &[u8; 33],
) -> bool {
    let [link0, link1] = chain else {
        return false;
    };
    let mut claim = Vec::new();
    lp(&mut claim, b"dstack-guest-v1-key-claim");
    lp(&mut claim, algorithm.as_bytes());
    lp(&mut claim, domain.as_bytes());
    lp(&mut claim, public_key);
    let Some(app_root) = recover(&keccak256(&claim).0, link0) else {
        return false;
    };
    let app_root = app_root.to_sec1_point(true);
    let mut message = b"dstack-kms-issued:".to_vec();
    message.extend_from_slice(app_id);
    message.extend_from_slice(app_root.as_bytes());
    recover(&keccak256(&message).0, link1)
        .is_some_and(|kms| kms.to_sec1_point(true).as_bytes() == kms_root.as_slice())
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// The worked claim of `docs/guest-api-v1.md`: app root key `1a2b…2b`, domain
    /// `storage-encryption`, secp256k1, and its link 0.
    const APP_ROOT: &str = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b";
    const PUBLIC: &str = "03d962450a41748021c8b02787ac36ce642ff0ae25f4c55019eb527e1112cfd764";
    const LINK0: &str = "5b6193729ce7976ec67863f21692d4b98c69832698aae8e001a7d33a6f818b6e46ca950725b6e90e8ca9bcf394abd03ce264bf9b7eec1e91693247f9dd53c26901";

    fn link1(kms: &SigningKey, app_id: &[u8]) -> Vec<u8> {
        let app_root = SigningKey::from_slice(&hex(APP_ROOT)).unwrap();
        let mut message = b"dstack-kms-issued:".to_vec();
        message.extend_from_slice(app_id);
        message.extend_from_slice(app_root.verifying_key().to_sec1_point(true).as_bytes());
        let (sig, id) = kms.sign_prehash_recoverable(&keccak256(&message).0);
        [sig.to_bytes().to_vec(), vec![id.to_byte()]].concat()
    }

    #[test]
    fn verifies_the_documented_claim_under_a_kms() {
        let kms = SigningKey::from_slice(&[7; 32]).unwrap();
        let root: [u8; 33] = kms
            .verifying_key()
            .to_sec1_point(true)
            .as_bytes()
            .try_into()
            .unwrap();
        let app = [9; 20];
        let chain = vec![hex(LINK0), link1(&kms, &app)];
        let public = hex(PUBLIC);
        assert!(verify_chain(
            "secp256k1",
            "storage-encryption",
            &public,
            &chain,
            &app,
            &root
        ));

        assert!(!verify_chain(
            "secp256k1",
            "storage",
            &public,
            &chain,
            &app,
            &root
        ));
        assert!(!verify_chain(
            "ed25519",
            "storage-encryption",
            &public,
            &chain,
            &app,
            &root
        ));
        assert!(!verify_chain(
            "secp256k1",
            "storage-encryption",
            &public,
            &chain,
            &[8; 20],
            &root
        ));
        assert!(!verify_chain(
            "secp256k1",
            "storage-encryption",
            &public,
            &chain,
            &app,
            &KMS_ROOT
        ));
        assert!(!verify_chain(
            "secp256k1",
            "storage-encryption",
            &public,
            &chain[..1],
            &app,
            &root
        ));
        let mut bad = chain.clone();
        bad[0][10] ^= 1;
        assert!(!verify_chain(
            "secp256k1",
            "storage-encryption",
            &public,
            &bad,
            &app,
            &root
        ));
    }
}
