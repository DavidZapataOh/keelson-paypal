use std::fmt;

/// Errors returned by the core primitives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// A JSON number was not an integer.
    NonInteger,
    /// A JSON integer was outside the range ±(2^53 - 1).
    UnsafeInteger,
    /// The JSON value could not be serialized.
    Serialize(String),
    /// The chain id is not an Arbitrum Sepolia or Arbitrum One id.
    UnsupportedChain(u64),
    /// The currency is not supported by the PayPal REST API.
    UnsupportedCurrency(String),
    /// A PayPal amount string was malformed or out of range.
    InvalidAmount(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonInteger => f.write_str("non-integer number"),
            Self::UnsafeInteger => f.write_str("unsafe integer"),
            Self::Serialize(e) => write!(f, "serialization failed: {e}"),
            Self::UnsupportedChain(id) => write!(f, "unsupported chain id: {id}"),
            Self::UnsupportedCurrency(c) => write!(f, "unsupported currency: {c}"),
            Self::InvalidAmount(a) => write!(f, "invalid amount: {a}"),
        }
    }
}

impl std::error::Error for Error {}
