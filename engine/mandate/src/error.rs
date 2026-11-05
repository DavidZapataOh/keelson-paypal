use std::fmt;

/// Errors returned by the mandate model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The mandate does not match the `keelson.mandate.1` schema.
    Mandate { field: String, reason: String },
    /// A disclosure or an SD-JWT payload is malformed or does not match.
    Disclosure(String),
    /// A credential failed verification.
    Credential(String),
    /// A commitment input is out of range.
    Commitment(String),
    /// Input JSON is outside the accepted profile: unsafe numbers, deep nesting or reserved
    /// digests.
    Json(String),
    /// A core primitive failed.
    Core(keelson_core::Error),
}

impl Error {
    pub(crate) fn mandate(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::Mandate {
            field: field.into(),
            reason: reason.into(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mandate { field, reason } => write!(f, "{field}: {reason}"),
            Self::Disclosure(e) => write!(f, "invalid disclosure: {e}"),
            Self::Credential(e) => write!(f, "invalid credential: {e}"),
            Self::Commitment(e) => write!(f, "invalid commitment input: {e}"),
            Self::Json(e) => write!(f, "rejected JSON: {e}"),
            Self::Core(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for Error {}

impl From<keelson_core::Error> for Error {
    fn from(e: keelson_core::Error) -> Self {
        Self::Core(e)
    }
}
