//! The Keelson TEE engine: countersign digests, the attested signer binding and the in-memory signer.

mod countersign;
mod error;
mod report_data;
mod signer;

pub use countersign::{
    BIT_CANON, BIT_CEDAR_ERROR, BIT_EXTRA, BIT_PAYPAL, FIELD_BITS, countersign_digest,
    failed_fields_mask,
};
pub use error::Error;
pub use report_data::{SignerBinding, TeeKind, report_data};
pub use signer::Signer;
