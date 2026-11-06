//! The HTTP surface of the engine. It translates requests to [`Engine`] calls and refusals to
//! `application/problem+json` (RFC 9457); it decides nothing.

use std::sync::Arc;

use alloy_primitives::Address;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use time::OffsetDateTime;

use crate::wire::{CountersignRequest, Countersigned, MandateIssued, RegisterMandate};
use crate::{Engine, EngineError, TeeKind};

/// Largest request body, in bytes.
pub const BODY_LIMIT: usize = 256 * 1024;

const PROBLEM_BASE: &str = "https://keelson.finance/problems/";

/// What the routes share: the engine and the hash of the bearer token it accepts.
pub struct AppState {
    engine: Engine,
    token_hash: [u8; 32],
    clock: fn() -> OffsetDateTime,
    #[cfg(feature = "tdx")]
    attestation: Option<std::sync::RwLock<Attested>>,
}

impl AppState {
    /// `token_hash` is `SHA-256` of the bearer token; the token itself is never held.
    pub fn new(engine: Engine, token_hash: [u8; 32]) -> Self {
        Self {
            engine,
            token_hash,
            clock: OffsetDateTime::now_utc,
            #[cfg(feature = "tdx")]
            attestation: None,
        }
    }

    /// Serves `attestation`, whose block was read at `at`, on `GET /v1/attestation` and renews
    /// it on `POST /v1/attestation/refresh` and [`spawn_reattest`].
    #[cfg(feature = "tdx")]
    pub fn with_attestation(
        mut self,
        attestation: crate::tdx::Attestation,
        at: OffsetDateTime,
    ) -> Self {
        self.attestation = Some(std::sync::RwLock::new(Attested { attestation, at }));
        self
    }

    /// Reads the time from `clock` instead of the system clock.
    pub fn with_clock(mut self, clock: fn() -> OffsetDateTime) -> Self {
        self.clock = clock;
        self
    }
}

/// The routes of one leg. `GET /v1/health` and `GET /v1/attestation` are open; every other route
/// needs the bearer token. The attestation routes exist only on a leg with an attestation.
pub fn router(state: Arc<AppState>) -> Router {
    let open = Router::new().route("/v1/health", get(health));
    let protected = Router::new()
        .route("/v1/countersign", post(countersign))
        .route("/v1/mandates/register", post(register))
        .layer(DefaultBodyLimit::max(BODY_LIMIT));
    #[cfg(feature = "tdx")]
    let (open, protected) = if state.attestation.is_some() {
        (
            open.route("/v1/attestation", get(attestation)),
            protected.route("/v1/attestation/refresh", post(refresh)),
        )
    } else {
        (open, protected)
    };
    let protected = protected.route_layer(middleware::from_fn_with_state(state.clone(), bearer));
    open.merge(protected)
        .fallback(|| async { Problem::new(StatusCode::NOT_FOUND, "not_found") })
        .method_not_allowed_fallback(|| async {
            Problem::new(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed")
        })
        .with_state(state)
}

/// A refusal on the wire. It carries a stable code and never the request.
struct Problem {
    status: StatusCode,
    code: String,
    detail: Option<&'static str>,
}

impl Problem {
    fn new(status: StatusCode, code: &str) -> Self {
        Self {
            status,
            code: code.into(),
            detail: None,
        }
    }
}

impl From<EngineError> for Problem {
    fn from(e: EngineError) -> Self {
        let status = match &e {
            EngineError::Auth(_) => StatusCode::FORBIDDEN,
            EngineError::Clock | EngineError::Replay => StatusCode::CONFLICT,
            EngineError::NoRoot => StatusCode::NOT_IMPLEMENTED,
            EngineError::CommitmentMismatch
            | EngineError::BadRequest(_)
            | EngineError::Expired
            | EngineError::NotYetValid => StatusCode::UNPROCESSABLE_ENTITY,
            EngineError::TooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            EngineError::NotReady => StatusCode::SERVICE_UNAVAILABLE,
            EngineError::Signer(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let detail = match e {
            EngineError::BadRequest(what) | EngineError::TooLarge(what) => Some(what),
            _ => None,
        };
        Self {
            status,
            code: e.code(),
            detail,
        }
    }
}

impl IntoResponse for Problem {
    fn into_response(self) -> Response {
        let mut body = json!({
            "type": format!("{PROBLEM_BASE}{}", self.code),
            "title": self.status.canonical_reason().unwrap_or_default(),
            "status": self.status.as_u16(),
            "code": self.code,
        });
        if let Some(detail) = self.detail {
            body["detail"] = detail.into();
        }
        let mut response = (self.status, body.to_string()).into_response();
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/problem+json"),
        );
        response
    }
}

/// Requires `Authorization: Bearer <token>` whose SHA-256 is the configured hash, compared in
/// constant time.
async fn bearer(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    let presented = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, token)| token);
    let known = presented.is_some_and(|token| {
        let hash: [u8; 32] = Sha256::digest(token).into();
        hash.ct_eq(&state.token_hash).into()
    });
    if known {
        return next.run(request).await;
    }
    let mut response = Problem::new(StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    response
        .headers_mut()
        .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
    response
}

#[derive(Serialize)]
struct Health {
    tee: TeeKind,
    signer: Address,
    boot_epoch: u64,
    oci_digest: String,
    version: &'static str,
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Health> {
    let engine = &state.engine;
    Json(Health {
        tee: engine.config().tee_kind,
        signer: engine.signer(),
        boot_epoch: engine.boot_epoch(),
        oci_digest: engine.config().oci_digest.clone(),
        version: env!("CARGO_PKG_VERSION"),
    })
}

fn parse<T: for<'de> Deserialize<'de>>(body: Result<Bytes, BytesRejection>) -> Result<T, Problem> {
    let body = body.map_err(|rejection| {
        let status = rejection.status();
        let code = if status == StatusCode::PAYLOAD_TOO_LARGE {
            "payload_too_large"
        } else {
            "bad_request"
        };
        Problem::new(status, code)
    })?;
    serde_json::from_slice(&body).map_err(|e| {
        let status = if e.is_data() {
            StatusCode::UNPROCESSABLE_ENTITY
        } else {
            StatusCode::BAD_REQUEST
        };
        Problem {
            status,
            code: "bad_request".into(),
            detail: Some("the body is not a valid request"),
        }
    })
}

/// Runs `f` off the async threads: verification and signing are CPU-bound.
async fn blocking<T: Serialize + Send + 'static>(
    f: impl FnOnce() -> Result<T, EngineError> + Send + 'static,
) -> Result<Json<T>, Problem> {
    match tokio::task::spawn_blocking(f).await {
        Ok(out) => Ok(Json(out?)),
        Err(_) => Err(Problem::new(StatusCode::INTERNAL_SERVER_ERROR, "internal")),
    }
}

async fn countersign(
    State(state): State<Arc<AppState>>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<Countersigned>, Problem> {
    let request: CountersignRequest = parse(body)?;
    blocking(move || state.engine.countersign(&request, (state.clock)())).await
}

async fn register(
    State(state): State<Arc<AppState>>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<MandateIssued>, Problem> {
    let request: RegisterMandate = parse(body)?;
    blocking(move || state.engine.register_mandate(&request, (state.clock)())).await
}

/// How long an attestation is served after its block was read; past it `GET /v1/attestation`
/// answers `attestation_stale`.
#[cfg(feature = "tdx")]
pub const ATTESTATION_MAX_AGE: time::Duration = time::Duration::hours(1);

/// How often [`spawn_reattest`] attests over a new block, inside [`ATTESTATION_MAX_AGE`] so one
/// failed attempt leaves the served attestation valid.
#[cfg(feature = "tdx")]
pub const REATTEST_EVERY: time::Duration = time::Duration::minutes(50);

/// An attestation and when its block was read.
#[cfg(feature = "tdx")]
struct Attested {
    attestation: crate::tdx::Attestation,
    at: OffsetDateTime,
}

#[cfg(feature = "tdx")]
impl AppState {
    fn attested(&self) -> &std::sync::RwLock<Attested> {
        self.attestation
            .as_ref()
            .expect("routed only with an attestation")
    }
}

/// Attests the engine's signer over the latest block and serves that from then on, unless a
/// newer one is already served. On failure the served attestation stays as it was.
#[cfg(feature = "tdx")]
pub async fn reattest(state: &AppState) -> Result<crate::tdx::Attestation, crate::tdx::BootError> {
    let at = (state.clock)();
    let fresh = crate::tdx::attest(&state.engine).await?;
    let mut served = state.attested().write().unwrap_or_else(|e| e.into_inner());
    if fresh.block.number >= served.attestation.block.number {
        *served = Attested {
            attestation: fresh,
            at,
        };
    }
    Ok(served.attestation.clone())
}

/// Calls [`reattest`] every [`REATTEST_EVERY`], so the served block is never an hour old while
/// the agent and the RPC answer.
#[cfg(feature = "tdx")]
pub fn spawn_reattest(state: Arc<AppState>) -> tokio::task::JoinHandle<()> {
    let period = std::time::Duration::try_from(REATTEST_EVERY).expect("a positive period");
    tokio::spawn(async move {
        let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticks.tick().await;
            if let Err(e) = reattest(&state).await {
                eprintln!("keelson-engine: attestation refresh failed: {e}");
            }
        }
    })
}

#[cfg(feature = "tdx")]
async fn attestation(
    State(state): State<Arc<AppState>>,
) -> Result<Json<crate::tdx::Attestation>, Problem> {
    let served = state.attested().read().unwrap_or_else(|e| e.into_inner());
    if (state.clock)() - served.at > ATTESTATION_MAX_AGE {
        return Err(Problem::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "attestation_stale",
        ));
    }
    Ok(Json(served.attestation.clone()))
}

#[cfg(feature = "tdx")]
async fn refresh(
    State(state): State<Arc<AppState>>,
) -> Result<Json<crate::tdx::Attestation>, Problem> {
    reattest(&state).await.map(Json).map_err(|e| {
        eprintln!("keelson-engine: attestation refresh failed: {e}");
        Problem::new(StatusCode::BAD_GATEWAY, "attestation")
    })
}
