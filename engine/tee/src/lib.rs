//! The Keelson TEE engine: it registers mandates and countersigns carts, with the attested
//! in-memory signer and the keys derived from the KMS root.

mod budget;
mod countersign;
mod engine;
mod error;
mod keys;
mod report_data;
mod signer;
pub mod wire;

pub use budget::Budget;
pub use countersign::{
    BIT_CANON, BIT_CEDAR_ERROR, BIT_EXTRA, BIT_PAYPAL, FIELD_BITS, countersign_digest,
    failed_fields_mask,
};
pub use engine::{
    CapturedSource, Engine, EngineConfig, EngineError, MANDATE_SALT_PURPOSE, USER_PASSKEY_PURPOSE,
    UserRecords,
};
pub use error::Error;
pub use keys::{Root, SealAad, SealError};
pub use report_data::{SignerBinding, TeeKind, report_data};
pub use signer::Signer;
