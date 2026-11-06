use std::fmt;

/// Errors of the TEE engine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// The chain id is neither Arbitrum Sepolia nor Arbitrum One.
    UnsupportedChain(u64),
    /// The EIP-712 domain carries no chain id, or one wider than 64 bits.
    MissingChain,
    /// The TEE kind is neither TDX (1) nor Nitro (2).
    UnknownTeeKind(u8),
    /// The signature's recovery id cannot be expressed as `v ∈ {27, 28}`.
    UnusableSignature,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedChain(id) => write!(f, "unsupported chain id: {id}"),
            Self::MissingChain => f.write_str("the domain has no usable chain id"),
            Self::UnknownTeeKind(kind) => write!(f, "unknown tee kind: {kind}"),
            Self::UnusableSignature => f.write_str("the signature has an unusable recovery id"),
        }
    }
}

impl std::error::Error for Error {}

/// Accepts the chains `keelson_core::domain` accepts.
pub(crate) fn check_chain(chain_id: u64) -> Result<(), Error> {
    keelson_core::domain(chain_id, alloy_primitives::Address::ZERO)
        .map(drop)
        .map_err(|_| Error::UnsupportedChain(chain_id))
}
