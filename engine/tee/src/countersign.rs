//! The `Countersign` digest and its `failedFieldsMask`.

use alloy_sol_types::{Eip712Domain, SolStruct};
use keelson_core::eip712::Countersign;

pub use keelson_policy::{
    BIT_CANON, BIT_CEDAR_ERROR, BIT_EXTRA, BIT_PAYPAL, FIELD_BITS, failed_fields_mask,
};

/// The EIP-712 signing hash of `c` under `domain`.
pub fn countersign_digest(c: &Countersign, domain: &Eip712Domain) -> [u8; 32] {
    c.eip712_signing_hash(domain).0
}
