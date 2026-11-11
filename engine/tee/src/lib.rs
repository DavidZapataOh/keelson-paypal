//! The Keelson TEE engine: it registers mandates and countersigns carts, with the attested
//! in-memory signer and the keys derived from the KMS root.

mod budget;
#[cfg(feature = "tdx")]
pub mod chain;
pub mod checkpoint;
mod countersign;
mod engine;
mod error;
mod keys;
#[cfg(feature = "nitro")]
pub mod nitro;
#[cfg(feature = "tdx")]
pub mod notary;
pub mod paypal;
pub mod process;
mod records;
mod report_data;
pub mod server;
mod signer;
#[cfg(feature = "tdx")]
pub mod tdx;
pub mod wire;
pub mod zk;

pub use budget::{Budget, ClaimGuard, Claimed, Replay};
pub use countersign::{
    BIT_CANON, BIT_CEDAR_ERROR, BIT_EXTRA, BIT_PAYPAL, FIELD_BITS, countersign_digest,
    failed_fields_mask,
};
pub use engine::{
    C1Status, CapturedSource, Engine, EngineConfig, EngineError, MANDATE_SALT_PURPOSE, UserRecords,
};
pub use error::Error;
pub use keys::{Root, SealAad, SealError};
pub use records::FileRecords;
pub use report_data::{SignerBinding, TeeKind, report_data};
pub use signer::Signer;
