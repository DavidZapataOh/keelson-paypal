//! The 64-byte `report_data` that binds the signer into a TEE attestation.

use alloy_primitives::{Address, B256, U256, keccak256};
use alloy_sol_types::{SolType, sol_data};
use serde::{Deserialize, Serialize};

use crate::Error;
use crate::error::check_chain;
use crate::wire::{Hex, Hex32};

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

/// The TEE technology that produced the attestation; serialized as its number.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(into = "u8", try_from = "u8")]
#[repr(u8)]
pub enum TeeKind {
    Tdx = 1,
    Nitro = 2,
}

impl From<TeeKind> for u8 {
    fn from(kind: TeeKind) -> Self {
        kind as u8
    }
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

/// Everything the attestation binds the signer to. Its JSON form is camelCase with `chainId`
/// and `bootEpoch` as decimal strings, addresses checksummed (EIP-55) and `teeKind` as its
/// number.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(into = "BindingJson", try_from = "BindingJson")]
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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BindingJson {
    chain_id: String,
    bond_vault: String,
    tee_kind: TeeKind,
    signer: String,
    policy_set_hash: Hex32,
    engine_build_id: Hex32,
    boot_epoch: String,
}

impl From<SignerBinding> for BindingJson {
    fn from(b: SignerBinding) -> Self {
        Self {
            chain_id: b.chain_id.to_string(),
            bond_vault: b.bond_vault.to_checksum(None),
            tee_kind: b.tee_kind,
            signer: b.signer.to_checksum(None),
            policy_set_hash: Hex(b.policy_set_hash),
            engine_build_id: Hex(b.engine_build_id),
            boot_epoch: b.boot_epoch.to_string(),
        }
    }
}

impl TryFrom<BindingJson> for SignerBinding {
    type Error = &'static str;

    fn try_from(b: BindingJson) -> Result<Self, Self::Error> {
        let address = |a: &str| a.parse::<Address>().map_err(|_| "address");
        let number = |n: &str| n.parse().map_err(|_| "number");
        Ok(Self {
            chain_id: number(&b.chain_id)?,
            bond_vault: address(&b.bond_vault)?,
            tee_kind: b.tee_kind,
            signer: address(&b.signer)?,
            policy_set_hash: b.policy_set_hash.0,
            engine_build_id: b.engine_build_id.0,
            boot_epoch: number(&b.boot_epoch)?,
        })
    }
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
