//! The 64-byte `report_data` that binds the signer into a TEE attestation.

use alloy_primitives::{Address, B256, U256, keccak256};
use alloy_sol_types::{SolType, sol_data};

use crate::Error;
use crate::error::check_chain;

type Binding = (
    sol_data::FixedBytes<32>,
    sol_data::Uint<256>,
    sol_data::Address,
    sol_data::Uint<8>,
    sol_data::Address,
    sol_data::FixedBytes<32>,
    sol_data::FixedBytes<32>,
    sol_data::Uint<64>,
);

/// The TEE technology that produced the attestation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum TeeKind {
    Tdx = 1,
    Nitro = 2,
}

impl TryFrom<u8> for TeeKind {
    type Error = Error;

    fn try_from(kind: u8) -> Result<Self, Error> {
        match kind {
            1 => Ok(Self::Tdx),
            2 => Ok(Self::Nitro),
            k => Err(Error::UnknownTeeKind(k)),
        }
    }
}

/// Everything the attestation binds the signer to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignerBinding {
    pub chain_id: u64,
    pub bond_vault: Address,
    pub tee_kind: TeeKind,
    pub signer: Address,
    pub policy_set_hash: [u8; 32],
    /// The OCI image digest of the engine.
    pub engine_build_id: [u8; 32],
    pub boot_epoch: u64,
}

/// `keccak256(abi.encode(keccak256("KEELSON_TEE_SIGNER_V1"), chainId, bondVault, teeKind,
/// signer, policySetHash, engineBuildId, bootEpoch)) ‖ blockHash`.
///
/// Fails on chains other than Arbitrum Sepolia and Arbitrum One.
pub fn report_data(b: &SignerBinding, block_hash: [u8; 32]) -> Result<[u8; 64], Error> {
    check_chain(b.chain_id)?;
    let binding = keccak256(Binding::abi_encode(&(
        keccak256("KEELSON_TEE_SIGNER_V1"),
        U256::from(b.chain_id),
        b.bond_vault,
        b.tee_kind as u8,
        b.signer,
        B256::new(b.policy_set_hash),
        B256::new(b.engine_build_id),
        b.boot_epoch,
    )));
    let mut out = [0; 64];
    out[..32].copy_from_slice(binding.as_slice());
    out[32..].copy_from_slice(&block_hash);
    Ok(out)
}
