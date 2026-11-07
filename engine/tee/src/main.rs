//! `keelson-engine`: serves the engine over HTTP.
//!
//! ```text
//! keelson-engine [--platform tdx] --listen tcp:<addr>
//! ```
//!
//! With `--platform tdx` (cargo feature `tdx`) the engine runs as leg A in a dstack CVM: it takes
//! its root from the dstack KMS, attests its signer over the latest Arbitrum block and serves
//! `GET /v1/attestation`. Without it the engine holds no root and runs as a leg that countersigns
//! over an observation.
//!
//! Configuration comes from `KEELSON_*` environment variables:
//!
//! | Variable | |
//! | --- | --- |
//! | `KEELSON_TEE_KIND` | `tdx` or `nitro`; implied by `--platform tdx` |
//! | `KEELSON_OCI_DIGEST` | the image digest, `sha256:<hex>`, bound into the attestation |
//! | `KEELSON_CANONICALIZER` | the canonicalizer version recorded in every trace |
//! | `KEELSON_ORIGIN` | the origin passkey assertions are made on |
//! | `KEELSON_ISSUER_JWK` | the credential issuer's public JWK; not read with `--platform tdx` |
//! | `KEELSON_TEE_TOKEN_SHA256` | the hex SHA-256 of the bearer token |
//! | `KEELSON_CHAIN_ID` | optional, `421614` by default |
//! | `KEELSON_BOND_VAULT`, `KEELSON_VERIFYING_CONTRACT` | optional, the zero address by default |
//!
//! With `--platform tdx`, `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are required: the engine
//! reads the authorization of each cart it countersigns (`PAYPAL_ENV=live` selects the live API
//! over the sandbox). `ARBITRUM_SEPOLIA_RPC_URL` optionally replaces the public Arbitrum
//! Sepolia RPC, and `DSTACK_SIMULATOR_ENDPOINT` the dstack socket.

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

/// Where the engine runs and so where its root comes from.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Platform {
    /// No root: the configured issuer key, no attestation of its own.
    Plain,
    /// Leg A in a dstack CVM on Intel TDX.
    Tdx,
}

fn issuer() -> Result<Jwk, String> {
    let issuer: Value = serde_json::from_str(&var("KEELSON_ISSUER_JWK")?)
        .map_err(|_| "KEELSON_ISSUER_JWK is not JSON")?;
    Jwk::from_value(&issuer).map_err(|_| "KEELSON_ISSUER_JWK is not a P-256 JWK".into())
}

fn config(platform: Platform) -> Result<(EngineConfig, [u8; 32]), String> {
    let (tee_kind, issuer) = match platform {
        Platform::Tdx => (TeeKind::Tdx, None),
        Platform::Plain => match var("KEELSON_TEE_KIND")?.as_str() {
            "tdx" => (TeeKind::Tdx, Some(issuer()?)),
            "nitro" => (TeeKind::Nitro, Some(issuer()?)),
            _ => return Err("KEELSON_TEE_KIND must be tdx or nitro".into()),
        },
    };
    let token_hash = var("KEELSON_TEE_TOKEN_SHA256")?;
    let token_hash = serde_json::from_value::<Hex32>(format!("0x{token_hash}").into())
        .map_err(|_| "KEELSON_TEE_TOKEN_SHA256 must be 64 lowercase hex digits")?;
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
        issuer,
        origin: var("KEELSON_ORIGIN")?,
    };
    Ok((config, token_hash.0))
}

const USAGE: &str = "usage: keelson-engine [--platform tdx] --listen tcp:<addr>";

fn args() -> Result<(Platform, String), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (platform, rest) = match args.as_slice() {
        [flag, platform, rest @ ..] if flag == "--platform" => match platform.as_str() {
            "tdx" => (Platform::Tdx, rest),
            _ => return Err(USAGE.into()),
        },
        rest => (Platform::Plain, rest),
    };
    match rest {
        [flag, addr] if flag == "--listen" => addr
            .strip_prefix("tcp:")
            .map(|addr| (platform, addr.to_owned()))
            .ok_or_else(|| "--listen takes tcp:<addr>".into()),
        _ => Err(USAGE.into()),
    }
}

#[cfg(feature = "tdx")]
async fn tdx_state(config: EngineConfig, token_hash: [u8; 32]) -> Result<AppState, String> {
    let started = std::time::Instant::now();
    let at = time::OffsetDateTime::now_utc();
    let (engine, attestation) = keelson_tee::tdx::boot(config)
        .await
        .map_err(|e| e.to_string())?;
    eprintln!(
        "keelson-engine: dstack {} attested signer {} over block {} in {} ms",
        attestation.dstack_version,
        attestation.binding.signer,
        attestation.block.number,
        started.elapsed().as_millis()
    );
    let paypal = keelson_tee::paypal::PayPalClient::from_env()?;
    Ok(AppState::new(engine, token_hash)
        .with_attestation(attestation, at)
        .with_paypal(paypal))
}

#[cfg(not(feature = "tdx"))]
async fn tdx_state(_: EngineConfig, _: [u8; 32]) -> Result<AppState, String> {
    Err("--platform tdx needs a build with the tdx feature".into())
}

async fn run() -> Result<(), String> {
    let (platform, address) = args()?;
    let (config, token_hash) = config(platform)?;
    let state = match platform {
        Platform::Plain => AppState::new(Engine::new(config, None), token_hash),
        Platform::Tdx => tdx_state(config, token_hash).await?,
    };
    let state = Arc::new(state);
    #[cfg(feature = "tdx")]
    if platform == Platform::Tdx {
        keelson_tee::server::spawn_reattest(state.clone());
    }
    let listener = tokio::net::TcpListener::bind(&address)
        .await
        .map_err(|e| format!("cannot listen on {address}: {e}"))?;
    axum::serve(listener, router(state))
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
