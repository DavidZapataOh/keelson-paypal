//! The Arbitrum block whose hash `report_data` carries, read over Ethereum JSON-RPC.

use std::fmt;
use std::sync::Once;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::wire::parse_hex;

/// The public Arbitrum Sepolia RPC.
pub const ARBITRUM_SEPOLIA_RPC: &str = "https://sepolia-rollup.arbitrum.io/rpc";

const TIMEOUT: Duration = Duration::from_secs(5);

/// A JSON-RPC call that failed or answered something other than what was asked.
#[derive(Debug)]
pub enum ChainError {
    Http(reqwest::Error),
    /// The node answered with a JSON-RPC error.
    Rpc(String),
    /// The answer is not the shape the call returns.
    Malformed(&'static str),
}

impl fmt::Display for ChainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Http(e) => write!(f, "rpc request failed: {e}"),
            Self::Rpc(message) => write!(f, "rpc error: {message}"),
            Self::Malformed(what) => write!(f, "malformed rpc response: {what}"),
        }
    }
}

impl std::error::Error for ChainError {}

/// An HTTP client on rustls with the ring crypto provider, which the first call installs as the
/// process default.
pub fn http_client() -> reqwest::Client {
    static PROVIDER: Once = Once::new();
    PROVIDER.call_once(|| {
        // Fails only when a provider is already installed, which then serves as well.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    reqwest::Client::new()
}

/// `ARBITRUM_SEPOLIA_RPC_URL` when set, otherwise [`ARBITRUM_SEPOLIA_RPC`].
pub fn rpc_url() -> String {
    std::env::var("ARBITRUM_SEPOLIA_RPC_URL").unwrap_or_else(|_| ARBITRUM_SEPOLIA_RPC.into())
}

/// The number and hash of the latest block: `eth_getBlockByNumber("latest", false)`.
pub async fn latest_block(rpc: &str) -> Result<(u64, [u8; 32]), ChainError> {
    #[derive(Deserialize)]
    struct Block {
        number: String,
        hash: String,
    }
    let block: Block = call(rpc, "eth_getBlockByNumber", json!(["latest", false])).await?;
    let hash = parse_hex(&block.hash).ok_or(ChainError::Malformed("block hash"))?;
    Ok((quantity(&block.number)?, hash))
}

/// The chain id the node serves: `eth_chainId`.
pub async fn chain_id(rpc: &str) -> Result<u64, ChainError> {
    quantity(&call::<String>(rpc, "eth_chainId", json!([])).await?)
}

async fn call<T: for<'de> Deserialize<'de>>(
    rpc: &str,
    method: &str,
    params: Value,
) -> Result<T, ChainError> {
    #[derive(Deserialize)]
    struct Response<T> {
        result: Option<T>,
        error: Option<RpcError>,
    }
    #[derive(Deserialize)]
    struct RpcError {
        message: String,
    }
    let response: Response<T> = http_client()
        .post(rpc)
        .timeout(TIMEOUT)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(ChainError::Http)?
        .json()
        .await
        .map_err(ChainError::Http)?;
    match (response.result, response.error) {
        (_, Some(e)) => Err(ChainError::Rpc(e.message)),
        (Some(result), None) => Ok(result),
        (None, None) => Err(ChainError::Malformed("no result")),
    }
}

/// A JSON-RPC quantity: `0x` and hex digits without leading zeros.
fn quantity(s: &str) -> Result<u64, ChainError> {
    s.strip_prefix("0x")
        .and_then(|digits| u64::from_str_radix(digits, 16).ok())
        .ok_or(ChainError::Malformed("quantity"))
}
