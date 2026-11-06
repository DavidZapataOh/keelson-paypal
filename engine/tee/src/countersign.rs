//! The `Countersign` digest and its `failedFieldsMask`.

use alloy_sol_types::{Eip712Domain, SolStruct};
use keelson_core::eip712::Countersign;

/// The `failedFieldsMask` bit of each policy `@id`. Append-only.
pub const FIELD_BITS: [(&str, u8); 12] = [
    ("agent", 0),
    ("sanity", 1),
    ("currency", 2),
    ("amount", 3),
    ("budget", 4),
    ("merchant", 5),
    ("window", 6),
    ("quantity", 7),
    ("category", 8),
    ("variant", 9),
    ("returns", 10),
    ("returns_free", 11),
];
/// Set when any fired policy is outside the base table (a user extra such as `extra.0`).
pub const BIT_EXTRA: u8 = 28;
/// Set when the canonicalizer denied the cart.
pub const BIT_CANON: u8 = 29;
/// Set when Cedar reported diagnostics errors.
pub const BIT_CEDAR_ERROR: u8 = 30;
/// Set when the PayPal order check failed.
pub const BIT_PAYPAL: u8 = 31;

/// The EIP-712 signing hash of `c` under `domain`.
pub fn countersign_digest(c: &Countersign, domain: &Eip712Domain) -> [u8; 32] {
    c.eip712_signing_hash(domain).0
}

/// Builds `failedFieldsMask` from the fired policy ids and the fault flags.
///
/// Ids outside [`FIELD_BITS`] set [`BIT_EXTRA`], except the `base` permit.
pub fn failed_fields_mask(
    fired: &[impl AsRef<str>],
    errors: bool,
    canon: bool,
    paypal: bool,
) -> u32 {
    let mut mask = 0;
    for id in fired.iter().map(AsRef::as_ref) {
        match FIELD_BITS.iter().find(|(f, _)| *f == id) {
            Some((_, bit)) => mask |= 1 << bit,
            None if id == "base" => {}
            None => mask |= 1 << BIT_EXTRA,
        }
    }
    for (set, bit) in [
        (canon, BIT_CANON),
        (errors, BIT_CEDAR_ERROR),
        (paypal, BIT_PAYPAL),
    ] {
        if set {
            mask |= 1 << bit;
        }
    }
    mask
}
