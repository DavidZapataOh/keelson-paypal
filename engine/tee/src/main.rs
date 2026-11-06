//! `keelson-engine`: serves the engine over HTTP.
//!
//! ```text
//! keelson-engine --listen tcp:<addr>
//! ```
//!
//! Configuration comes from `KEELSON_*` environment variables:
//!
//! | Variable | |
//! | --- | --- |
//! | `KEELSON_TEE_KIND` | `tdx` or `nitro` |
//! | `KEELSON_OCI_DIGEST` | the image digest, bound into the attestation |
//! | `KEELSON_CANONICALIZER` | the canonicalizer version recorded in every trace |
//! | `KEELSON_ORIGIN` | the origin passkey assertions are made on |
//! | `KEELSON_ISSUER_JWK` | the credential issuer's public JWK |
//! | `KEELSON_TOKEN_SHA256` | the hex SHA-256 of the bearer token |
//! | `KEELSON_CHAIN_ID` | optional, `421614` by default |
//! | `KEELSON_BOND_VAULT`, `KEELSON_VERIFYING_CONTRACT` | optional, the zero address by default |
//!
//! This binary holds no KMS root, so it runs as a leg that countersigns over an observation.

use std::sync::Arc;

use alloy_primitives::Address;
use keelson_mandate::Jwk;
use keelson_tee::server::{AppState, router};
use keelson_tee::wire::Hex32;
use keelson_tee::{Engine, EngineConfig, TeeKind};
use serde_json::Value;

const DEFAULT_CHAIN_ID: u64 = 421_614;

fn var(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("{name} is not set"))
}

fn optional<T: std::str::FromStr>(name: &str, default: T) -> Result<T, String> {
    match std::env::var(name) {
        Ok(v) => v.parse().map_err(|_| format!("{name} is invalid")),
        Err(_) => Ok(default),
    }
}

fn config() -> Result<(EngineConfig, [u8; 32]), String> {
    let tee_kind = match var("KEELSON_TEE_KIND")?.as_str() {
        "tdx" => TeeKind::Tdx,
        "nitro" => TeeKind::Nitro,
        _ => return Err("KEELSON_TEE_KIND must be tdx or nitro".into()),
    };
    let issuer: Value = serde_json::from_str(&var("KEELSON_ISSUER_JWK")?)
        .map_err(|_| "KEELSON_ISSUER_JWK is not JSON")?;
    let issuer = Jwk::from_value(&issuer).map_err(|_| "KEELSON_ISSUER_JWK is not a P-256 JWK")?;
    let token_hash = var("KEELSON_TOKEN_SHA256")?;
    let token_hash = serde_json::from_value::<Hex32>(format!("0x{token_hash}").into())
        .map_err(|_| "KEELSON_TOKEN_SHA256 must be 64 lowercase hex digits")?;
    let chain_id = optional("KEELSON_CHAIN_ID", DEFAULT_CHAIN_ID)?;
    keelson_core::domain(chain_id, Address::ZERO)
        .map_err(|_| format!("unsupported chain id {chain_id}"))?;
    let config = EngineConfig {
        chain_id,
        bond_vault: optional("KEELSON_BOND_VAULT", Address::ZERO)?,
        verifying_contract: optional("KEELSON_VERIFYING_CONTRACT", Address::ZERO)?,
        oci_digest: var("KEELSON_OCI_DIGEST")?,
        canonicalizer: var("KEELSON_CANONICALIZER")?,
        tee_kind,
        issuer: Some(issuer),
        origin: var("KEELSON_ORIGIN")?,
    };
    Ok((config, token_hash.0))
}

fn listen_address() -> Result<String, String> {
    let mut args = std::env::args().skip(1);
    match (args.next().as_deref(), args.next(), args.next()) {
        (Some("--listen"), Some(addr), None) => addr
            .strip_prefix("tcp:")
            .map(str::to_owned)
            .ok_or_else(|| "--listen takes tcp:<addr>".into()),
        _ => Err("usage: keelson-engine --listen tcp:<addr>".into()),
    }
}

async fn run() -> Result<(), String> {
    let address = listen_address()?;
    let (config, token_hash) = config()?;
    let state = AppState::new(Engine::new(config, None), token_hash);
    let listener = tokio::net::TcpListener::bind(&address)
        .await
        .map_err(|e| format!("cannot listen on {address}: {e}"))?;
    axum::serve(listener, router(Arc::new(state)))
        .await
        .map_err(|e| e.to_string())
}

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("keelson-engine: {e}");
        std::process::exit(1);
    }
}
