//! Rust mirror of the Keelson core primitives.
//!
//! Every function here produces byte-identical output to its TypeScript counterpart.

mod alibi;
pub mod eip712;
mod error;
mod hash;
mod jcs;
mod money;
mod poseidon2;

pub use acir::{AcirField, FieldElement};
pub use alibi::{AlibiFields, alibi_digest};
pub use eip712::domain;
pub use error::Error;
pub use hash::{Dst, hash_object};
pub use jcs::jcs;
pub use money::{Money, currency_numeric, from_paypal_value, to_paypal_value};
pub use poseidon2::{field_from_ascii, poseidon2};
