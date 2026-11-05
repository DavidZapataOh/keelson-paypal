//! Rust mirror of the Keelson mandate model.
//!
//! Every function here mirrors its TypeScript counterpart in `@keelson/mandate`. Golden vectors
//! generated from the TypeScript side check that both accept and reject the same inputs and
//! produce byte-identical output.

mod b64;
mod challenge;
mod commitment;
mod credentials;
mod error;
mod schema;
mod sd;
mod strict;

pub use challenge::{h_sd, mandate_challenge};
pub use commitment::{
    CATEGORY_IDS, LeafPreimage, MERCHANT_TREE_CAPACITY, MembershipProof, MerchantTree,
    NonMembershipProof, category_mask, mandate_commitment, merchant_leaf, merchant_membership,
    merchant_non_membership, merchant_root, merchant_tree, user_key_hash,
    verify_merchant_membership, verify_merchant_non_membership,
};
pub use credentials::{
    Jwk, OPEN_MANDATE_TYP, OpenMandateOptions, USER_CREDENTIAL_TYP, USER_CREDENTIAL_VCT,
    VerifiedCredential, verify_credential,
};
pub use error::Error;
pub use schema::{MAX_LIFETIME_SECONDS, parse_mandate};
pub use sd::{decode_disclosed, decode_mandate};

/// An element of the BN254 scalar field.
pub type Fr = keelson_core::FieldElement;
