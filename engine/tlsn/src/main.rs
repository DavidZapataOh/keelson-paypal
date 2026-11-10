//! `keelson-prover`: proves public product endpoints to the notary on leg A.
//!
//! `POST /v1/prove` with `{ "url": "https://…", "anchor"?: "…", "mode"?: "mpc" | "proxy" }` runs
//! one session and answers with the notary's signed `WebFact` and the secret that opens its
//! range commitment. Without `mode` it runs MPC-TLS and, if that fails, Proxy-TLS. One session
//! runs at a time; the service is reachable on the private network only.
//!
//! | Variable | |
//! |---|---|
//! | `TEE_A_URL` | the notary, leg A's base URL |
//! | `KEELSON_TEE_TOKEN` | the bearer token leg A accepts |
//! | `PORT` | the port to listen on, `10000` by default |

use std::fmt::Write as _;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use keelson_tlsn::{Error, Mode, notary, prove};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Semaphore;

/// Longest one attempt may take, from connecting to the notary to its answer.
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(30);

struct Config {
    notary: String,
    token: String,
    slot: Semaphore,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProveRequest {
    url: String,
    anchor: Option<String>,
    mode: Option<Mode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Proved {
    web_fact: Value,
    mode: Mode,
    /// How long the session took, notary answer included.
    ms: u64,
    /// The committed range of the response, `[start, end)`.
    range: [usize; 2],
    /// The committed bytes, hex.
    committed: String,
    /// The commitment's blinder, hex.
    blinder: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

async fn attempt(config: &Config, request: &ProveRequest, mode: Mode) -> Result<Proved, Error> {
    let started = Instant::now();
    let io = notary::connect(&config.notary, &config.token).await?;
    let (proven, io) = prove(io, &request.url, request.anchor.as_deref(), mode).await?;
    let web_fact = notary::answer(io).await?;
    Ok(Proved {
        web_fact,
        mode,
        ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        range: [proven.range.start, proven.range.end],
        committed: hex(&proven.response[proven.range.clone()]),
        blinder: hex(&proven.blinder),
    })
}

async fn run(config: &Config, request: &ProveRequest, mode: Mode) -> Result<Proved, Error> {
    tokio::time::timeout(ATTEMPT_TIMEOUT, attempt(config, request, mode))
        .await
        .unwrap_or_else(|_| Err(Error::Tlsn("timeout".into())))
}

async fn prove_route(
    State(config): State<Arc<Config>>,
    Json(request): Json<ProveRequest>,
) -> Result<Json<Proved>, (StatusCode, Json<Value>)> {
    let _permit = config.slot.acquire().await.map_err(|_| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "closed" })),
        )
    })?;
    let result = match request.mode {
        Some(mode) => run(&config, &request, mode).await,
        None => match run(&config, &request, Mode::Mpc).await {
            Ok(p) => Ok(p),
            Err(e @ (Error::Url | Error::Status(_) | Error::Refused(_))) => Err(e),
            Err(e) => {
                eprintln!("mpc-tls failed ({e}); trying proxy-tls");
                run(&config, &request, Mode::Proxy).await
            }
        },
    };
    result.map(Json).map_err(|e| {
        eprintln!("prove failed: {e}");
        let status = match e {
            Error::Url | Error::Range | Error::Status(_) => StatusCode::UNPROCESSABLE_ENTITY,
            _ => StatusCode::BAD_GATEWAY,
        };
        (status, Json(json!({ "error": e.to_string() })))
    })
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let var = |name: &str| std::env::var(name).map_err(|_| format!("{name} is not set"));
    let config = Arc::new(Config {
        notary: var("TEE_A_URL")?,
        token: var("KEELSON_TEE_TOKEN")?,
        slot: Semaphore::new(1),
    });
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(10000);
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/v1/prove", post(prove_route))
        .with_state(config);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| e.to_string())?;
    axum::serve(listener, app).await.map_err(|e| e.to_string())
}
