//! Ed25519 signature verification (RFC 8032 §5.1.7) as an Arbitrum Stylus contract, with the
//! `IEd25519Verifier` interface of `contracts/src/interfaces/IEd25519Verifier.sol`. The EVM has no
//! Ed25519 precompile; in WASM a verification costs a fraction of its EVM bytecode equivalent.

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
#![cfg_attr(feature = "contract-client-gen", allow(unused_imports))]
extern crate alloc;

use alloy_primitives::FixedBytes;
use ed25519_compact::{PublicKey, Signature};
use stylus_sdk::{abi::Bytes, prelude::*};

#[storage]
#[entrypoint]
pub struct Ed25519Verifier;

#[public]
impl Ed25519Verifier {
    /// Whether `signature` (`R ‖ S`, 64 bytes) is `key`'s signature of `message`. A key that is not
    /// a point, a non-canonical `S` or a signature of another length is a `false`, never a revert.
    pub fn verify(&self, key: FixedBytes<32>, message: Bytes, signature: Bytes) -> bool {
        let (Ok(key), Ok(signature)) = (
            PublicKey::from_slice(&key[..]),
            Signature::from_slice(&signature),
        ) else {
            return false;
        };
        key.verify(&message[..], &signature).is_ok()
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use stylus_sdk::testing::*;

    fn hex(s: &str) -> alloc::vec::Vec<u8> {
        let s = s.trim_start_matches("0x");
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn verify(key: &[u8], message: &[u8], signature: &[u8]) -> bool {
        let vm = TestVM::default();
        let contract = Ed25519Verifier::from(&vm);
        contract.verify(
            FixedBytes::from_slice(key),
            message.to_vec().into(),
            signature.to_vec().into(),
        )
    }

    #[test]
    fn rfc8032_test_1() {
        let key = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        let sig = hex(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
        );
        assert!(verify(&key, b"", &sig));
        assert!(!verify(&key, b"\0", &sig));
        assert!(!verify(&key, b"", &sig[..63]));
    }

    /// The same 1,024 vectors (Bernstein et al.'s `sign.input`) as the EVM verifier's tests.
    #[test]
    fn sign_input_vectors() {
        let file = include_str!("../../../lib/crypto-lib/test/utils/ed25519tv.json");
        let mut count = 0;
        for line in file.lines().filter(|l| !l.is_empty()) {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            let field = |k: &str| hex(v[k].as_str().unwrap());
            let mut sig = [field("r"), field("s")].concat();
            assert!(
                verify(&field("kpub"), &field("msg"), &sig),
                "vector {count}"
            );
            sig[20] ^= 0x08;
            assert!(
                !verify(&field("kpub"), &field("msg"), &sig),
                "tampered {count}"
            );
            count += 1;
        }
        assert_eq!(count, 1024);
    }

    #[test]
    fn refuses_keys_that_are_not_points_and_non_canonical_s() {
        let sig = [0u8; 64];
        let mut not_a_point = [0u8; 32];
        not_a_point[0] = 2;
        assert!(!verify(&not_a_point, b"", &sig));
        let key = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        let mut sig = hex(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
        );
        // S + L, little-endian.
        let l = hex("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010");
        let mut carry = 0u16;
        for i in 0..32 {
            let v = sig[32 + i] as u16 + l[i] as u16 + carry;
            sig[32 + i] = v as u8;
            carry = v >> 8;
        }
        assert!(!verify(&key, b"", &sig));
    }
}
