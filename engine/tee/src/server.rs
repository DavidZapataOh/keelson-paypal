//! The HTTP surface of the engine. It translates requests to [`Engine`] calls and refusals to
//! `application/problem+json` (RFC 9457); it decides nothing.

use std::sync::Arc;

use alloy_primitives::Address;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{DefaultBodyLimit, Path, Request, State};
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

use crate::engine::{C1Status, unix_ms};
use crate::logsign::SignError;
#[cfg(feature = "tdx")]
use crate::logsign::{SignRequest, Signed};
use crate::wire::{
    CardAuthorizeRequest, CardAuthorized, CheckpointRequest, CheckpointSigned, CountersignRequest,
    Countersigned, MandateIssued, RegisterMandate, VerdictRequest, VerdictSigned, ZkProof,
};
use crate::{Engine, EngineError, TeeKind};

/// Largest request body, in bytes.
pub const BODY_LIMIT: usize = 256 * 1024;

/// Largest `POST /v1/checkpoint` body, in bytes.
pub const CHECKPOINT_BODY_LIMIT: usize = 16 * 1024;

const PROBLEM_BASE: &str = "https://keelson.finance/problems/";

/// What the routes share: the engine and the hash of the bearer token it accepts.
pub struct AppState {
    engine: Engine,
    /// Leg A's prover thread, started with the first ALLOW to prove.
    c1_queue: std::sync::OnceLock<std::sync::mpsc::SyncSender<String>>,
    token_hash: [u8; 32],
    clock: fn() -> OffsetDateTime,
    #[cfg(feature = "tdx")]
    attestation: Option<std::sync::RwLock<Attested>>,
    #[cfg(feature = "tdx")]
    paypal: Option<crate::paypal::PayPalClient>,
    #[cfg(feature = "nitro")]
    nitro: Option<crate::nitro::Nitro>,
    #[cfg(feature = "tdx")]
    notary: Option<Arc<tokio::sync::Semaphore>>,
    /// The SHA-256 of the RA-TLS certificate and the signer's signature over its binding.
    #[cfg(feature = "tdx")]
    tls: Option<TlsBinding>,
}

#[cfg(feature = "tdx")]
#[derive(Clone, Serialize)]
struct TlsBinding {
    certificate_sha256: crate::wire::Hex32,
    signature: crate::wire::Hex<65>,
    signer: Address,
}

impl AppState {
    /// `token_hash` is `SHA-256` of the bearer token; the token itself is never held.
    pub fn new(engine: Engine, token_hash: [u8; 32]) -> Self {
        Self {
            engine,
            c1_queue: std::sync::OnceLock::new(),
            token_hash,
            clock: OffsetDateTime::now_utc,
            #[cfg(feature = "tdx")]
            attestation: None,
            #[cfg(feature = "tdx")]
            paypal: None,
            #[cfg(feature = "nitro")]
            nitro: None,
            #[cfg(feature = "tdx")]
            notary: None,
            #[cfg(feature = "tdx")]
            tls: None,
        }
    }

    /// Serves `GET /v1/log/tls`: the signer's signature over the RA-TLS certificate whose
    /// SHA-256 is `certificate_sha256`.
    #[cfg(feature = "tdx")]
    pub fn with_tls_certificate(
        mut self,
        certificate_sha256: [u8; 32],
    ) -> Result<Self, crate::Error> {
        let signature = self
            .engine
            .sign_tls_binding(&crate::ratls::binding_digest(&certificate_sha256))?;
        self.tls = Some(TlsBinding {
            certificate_sha256: crate::wire::Hex(certificate_sha256),
            signature: crate::wire::Hex(signature),
            signer: self.engine.signer(),
        });
        Ok(self)
    }

    /// Serves `GET /v1/notary`: the leg notarizes TLS sessions and signs a `WebFact` for each
    /// it accepts.
    #[cfg(feature = "tdx")]
    pub fn with_notary(mut self) -> Self {
        self.notary = Some(Arc::new(tokio::sync::Semaphore::new(1)));
        self
    }

    #[cfg(feature = "tdx")]
    pub(crate) fn notary_slot(&self) -> &Arc<tokio::sync::Semaphore> {
        self.notary.as_ref().expect("routed only with a notary")
    }

    /// Makes leg A read the request's PayPal authorization through `client` before every
    /// countersign.
    #[cfg(feature = "tdx")]
    pub fn with_paypal(mut self, client: crate::paypal::PayPalClient) -> Self {
        self.paypal = Some(client);
        self
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

    /// Serves the enclave's attestation on `GET /v1/attestation` and renews it on
    /// `POST /v1/attestation/refresh`.
    #[cfg(feature = "nitro")]
    pub(crate) fn with_nitro(mut self, nitro: crate::nitro::Nitro) -> Self {
        self.nitro = Some(nitro);
        self
    }

    #[cfg(any(feature = "tdx", feature = "nitro"))]
    pub(crate) fn engine(&self) -> &Engine {
        &self.engine
    }

    #[cfg(feature = "nitro")]
    pub(crate) fn nitro(&self) -> &crate::nitro::Nitro {
        self.nitro
            .as_ref()
            .expect("routed only with an attestation")
    }

    #[cfg(any(feature = "tdx", feature = "nitro"))]
    pub(crate) fn now(&self) -> OffsetDateTime {
        (self.clock)()
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
        .route("/v1/c1/{request_id}", get(c1))
        .route(
            "/v1/checkpoint",
            post(checkpoint).layer(DefaultBodyLimit::max(CHECKPOINT_BODY_LIMIT)),
        )
        .route("/v1/mandates/register", post(register))
        .route("/v1/verdict", post(verdict))
        .route("/v1/card/authorize", post(card_authorize))
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
    #[cfg(feature = "tdx")]
    let open = match state.tls.clone() {
        Some(tls) => open.route("/v1/log/tls", get(move || async move { Json(tls) })),
        None => open,
    };
    #[cfg(feature = "tdx")]
    let protected = if state.notary.is_some() {
        protected.route("/v1/notary", get(crate::notary::notary))
    } else {
        protected
    };
    #[cfg(feature = "nitro")]
    let (open, protected) = if state.nitro.is_some() {
        (
            open.route("/v1/attestation", get(crate::nitro::attestation)),
            protected.route(
                "/v1/attestation/refresh",
                post(crate::nitro::refresh).layer(DefaultBodyLimit::max(BODY_LIMIT)),
            ),
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
pub(crate) struct Problem {
    status: StatusCode,
    code: String,
    detail: Option<&'static str>,
    /// The last size signed for the origin, on a `log_not_extending` refusal.
    latest: Option<u64>,
}

impl Problem {
    pub(crate) fn new(status: StatusCode, code: &str) -> Self {
        Self {
            status,
            code: code.into(),
            detail: None,
            latest: None,
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
            | EngineError::NotYetValid
            | EngineError::Checkpoint(_) => StatusCode::UNPROCESSABLE_ENTITY,
            EngineError::TooLarge(_) => StatusCode::PAYLOAD_TOO_LARGE,
            EngineError::NotReady | EngineError::Busy => StatusCode::SERVICE_UNAVAILABLE,
            EngineError::Signer(_) => StatusCode::INTERNAL_SERVER_ERROR,
            EngineError::PayPal => StatusCode::BAD_GATEWAY,
            EngineError::Log(SignError::NotExtending { .. }) => StatusCode::CONFLICT,
            EngineError::Log(SignError::Format | SignError::Origin) => {
                StatusCode::UNPROCESSABLE_ENTITY
            }
            EngineError::Log(SignError::Records) => StatusCode::INTERNAL_SERVER_ERROR,
            EngineError::Log(SignError::NoFloor) => StatusCode::SERVICE_UNAVAILABLE,
        };
        let latest = match &e {
            EngineError::Log(SignError::NotExtending { latest }) => *latest,
            _ => None,
        };
        let detail = match e {
            EngineError::BadRequest(what) | EngineError::TooLarge(what) => Some(what),
            _ => None,
        };
        Self {
            status,
            code: e.code(),
            detail,
            latest,
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
        if let Some(latest) = self.latest {
            body["latest"] = latest.into();
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
    authorized(&state.token_hash, request, next).await
}

/// The routes of leg A's checkpoint signer, served only on its RA-TLS listener, so the
/// gateway's TLS-terminating route never reaches them.
#[cfg(feature = "tdx")]
pub fn log_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/log/sign", post(log_sign))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .route_layer(middleware::from_fn_with_state(state.clone(), bearer))
        .with_state(state)
}

async fn authorized(token_hash: &[u8; 32], request: Request, next: Next) -> Response {
    let presented = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, token)| token);
    let known = presented.is_some_and(|token| {
        let hash: [u8; 32] = Sha256::digest(token).into();
        hash.ct_eq(token_hash).into()
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
    /// The engine's clock, in Unix milliseconds.
    now_ms: i64,
    /// The credential issuer's public JWK, which `issuer_jwk_thumbprint` in the attestation covers.
    #[serde(skip_serializing_if = "Option::is_none")]
    issuer: Option<serde_json::Value>,
    /// Resident memory of the process in KiB, where the platform reports it.
    #[serde(skip_serializing_if = "Option::is_none")]
    rss_kib: Option<u64>,
    /// The Alibi origins' log keys leg A holds, as note verifier keys; on leg A with the KMS
    /// signature chain that proves the app derived each.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    log_keys: Vec<LogKeyInfo>,
}

#[derive(Serialize)]
pub(crate) struct LogKeyInfo {
    pub origin: &'static str,
    pub vkey: String,
    /// The raw Ed25519 public key, hex.
    pub public_key: String,
    /// `GetKey`'s signature chain, hex: absent on leg B.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub signature_chain: Vec<String>,
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Health> {
    let engine = &state.engine;
    Json(Health {
        tee: engine.config().tee_kind,
        signer: engine.signer(),
        boot_epoch: engine.boot_epoch(),
        oci_digest: engine.config().oci_digest.clone(),
        version: env!("CARGO_PKG_VERSION"),
        now_ms: unix_ms((state.clock)()).unwrap_or_default(),
        issuer: engine
            .issuer()
            .map(|k| json!({ "kty": "EC", "crv": "P-256", "x": k.x, "y": k.y })),
        rss_kib: crate::process::rss_kib(),
        log_keys: log_keys(engine),
    })
}

fn log_keys(engine: &Engine) -> Vec<LogKeyInfo> {
    let hex = |b: &[u8]| -> String { b.iter().map(|x| format!("{x:02x}")).collect() };
    if let Some(log) = engine.log_signer() {
        return log
            .keys()
            .iter()
            .map(|k| LogKeyInfo {
                origin: k.origin,
                vkey: k.vkey(),
                public_key: format!("0x{}", hex(&k.public_key())),
                signature_chain: k.signature_chain.iter().map(|l| hex(l)).collect(),
            })
            .collect();
    }
    engine
        .tee_log_keys()
        .iter()
        .map(|(origin, key)| LogKeyInfo {
            origin,
            vkey: crate::logsign::vkey(origin, key),
            public_key: format!("0x{}", hex(key)),
            signature_chain: Vec::new(),
        })
        .collect()
}

pub(crate) fn parse<T: for<'de> Deserialize<'de>>(
    body: Result<Bytes, BytesRejection>,
) -> Result<T, Problem> {
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
            latest: None,
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
    #[cfg(feature = "tdx")]
    let paypal = read_paypal(&state, &request).await?;
    #[cfg(not(feature = "tdx"))]
    let paypal = None;
    let id = request.request_id.to_string();
    let engine = state.clone();
    let out = blocking(move || {
        state
            .engine
            .countersign_with(&request, (state.clock)(), paypal)
    })
    .await?;
    // The answer goes out now; the proof follows on `GET /v1/c1/{request_id}`.
    if out.countersign.decision == "1" && engine.engine.proves_c1() {
        let queue = engine.c1_queue.get_or_init(|| {
            let (tx, rx) = std::sync::mpsc::sync_channel::<String>(C1_QUEUE);
            let prover = engine.clone();
            std::thread::spawn(move || {
                for id in rx {
                    prover.engine.prove_c1(&id);
                }
            });
            tx
        });
        if queue.try_send(id.clone()).is_err() {
            eprintln!("keelson-engine: C1 queue full, request {id} is not proved");
            engine.engine.forgo_c1(&id);
        }
    }
    Ok(out)
}

/// ALLOWs waiting for their C1 proof on leg A's prover thread, one proof at a time: about as many
/// as it proves within the minute the API waits for a proof.
const C1_QUEUE: usize = 64;
/// How often `GET /v1/c1/{request_id}` looks again at a proof still being made.
const C1_POLL: std::time::Duration = std::time::Duration::from_millis(20);

/// How long `GET /v1/c1/{request_id}` waits for a proof still being made: past the prover's own
/// deadline.
const C1_WAIT: std::time::Duration = std::time::Duration::from_secs(8);

/// The C1 proof of an ALLOW this leg answered: 404 `no_proof` when there is none to wait for,
/// 503 `proof_pending` when it is still being made after [`C1_WAIT`].
async fn c1(
    State(state): State<Arc<AppState>>,
    Path(request_id): Path<String>,
) -> Result<Json<ZkProof>, Problem> {
    let Ok(id) = request_id.parse::<ulid::Ulid>() else {
        return Err(Problem::new(StatusCode::NOT_FOUND, "no_proof"));
    };
    let id = id.to_string();
    let deadline = tokio::time::Instant::now() + C1_WAIT;
    loop {
        match state.engine.c1(&id, std::time::Duration::ZERO) {
            C1Status::Ready(proof) => return Ok(Json(proof)),
            C1Status::None => return Err(Problem::new(StatusCode::NOT_FOUND, "no_proof")),
            C1Status::Pending if tokio::time::Instant::now() >= deadline => {
                return Err(Problem::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "proof_pending",
                ));
            }
            C1Status::Pending => tokio::time::sleep(C1_POLL).await,
        }
    }
}

/// Leg A's own reading of the request's authorization, made now and not retried; none when the
/// request names no authorization.
#[cfg(feature = "tdx")]
async fn read_paypal(
    state: &AppState,
    request: &CountersignRequest,
) -> Result<Option<crate::wire::PayPalObservation>, Problem> {
    let (Some(client), None) = (&state.paypal, &request.observation) else {
        return Ok(None);
    };
    // Arbitrum One countersigns against the live PayPal API, every other chain against the sandbox.
    let chain_id = request.chain_id.unwrap_or(state.engine.config().chain_id);
    if (chain_id == 42_161) != client.is_live() {
        return Err(EngineError::BadRequest("chain_id").into());
    }
    // A card mandate is paid with a single-use card, so its countersign names no PayPal
    // authorization; the engine then refuses a PayPal mandate, which cannot skip its reading.
    let Some(id) = request.authorization_id.as_deref() else {
        return Ok(None);
    };
    match crate::paypal::observe(client, id).await {
        Ok(read) => Ok(Some(read)),
        Err(e) => {
            eprintln!("keelson-engine: {e}");
            Err(EngineError::PayPal.into())
        }
    }
}

#[cfg(feature = "tdx")]
async fn log_sign(
    State(state): State<Arc<AppState>>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<Signed>, Problem> {
    let request: SignRequest = parse(body)?;
    let origin = request
        .checkpoint
        .split('\n')
        .next()
        .unwrap_or_default()
        .to_owned();
    let floor = if state.engine.log_needs_floor(&origin)? {
        let chain_id = if origin.contains("/alibi-live/") {
            42_161
        } else {
            421_614
        };
        let hash = alloy_primitives::keccak256(origin.as_bytes()).0;
        Some(
            crate::chain::anchored(&crate::chain::rpc_url_for(chain_id), &hash)
                .await
                .map_err(|_| EngineError::Log(SignError::NoFloor))?,
        )
    } else {
        None
    };
    blocking(move || state.engine.sign_log(&request, floor)).await
}

async fn checkpoint(
    State(state): State<Arc<AppState>>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<CheckpointSigned>, Problem> {
    let request: CheckpointRequest = parse(body)?;
    blocking(move || state.engine.sign_checkpoint(&request, (state.clock)())).await
}

async fn verdict(
    State(state): State<Arc<AppState>>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<VerdictSigned>, Problem> {
    let request: VerdictRequest = parse(body)?;
    blocking(move || state.engine.sign_verdict(&request)).await
}

/// A card issuer's authorization of a single-use card, checked against the ALLOW it was issued
/// under. The card issuer waits about two seconds for the answer, so nothing here goes out.
async fn card_authorize(
    State(state): State<Arc<AppState>>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<CardAuthorized>, Problem> {
    let request: CardAuthorizeRequest = parse(body)?;
    blocking(move || state.engine.authorize_card(&request, (state.clock)())).await
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
#[cfg(any(feature = "tdx", feature = "nitro"))]
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

/// The chain of `?chainId=<id>`, when the query names one.
#[cfg(feature = "tdx")]
fn chain_query(uri: &axum::http::Uri) -> Result<Option<u64>, Problem> {
    let Some(query) = uri.query() else {
        return Ok(None);
    };
    match query.strip_prefix("chainId=").map(str::parse) {
        Some(Ok(chain_id)) => Ok(Some(chain_id)),
        _ => Err(EngineError::BadRequest("chain_id").into()),
    }
}

/// Renews the served attestation; for another chain than the engine's own, attests for it and
/// returns that without serving it.
#[cfg(feature = "tdx")]
async fn refresh(
    State(state): State<Arc<AppState>>,
    uri: axum::http::Uri,
) -> Result<Json<crate::tdx::Attestation>, Problem> {
    let own = state.engine.config().chain_id;
    let attested = match chain_query(&uri)? {
        Some(chain_id) if chain_id != own => crate::tdx::attest_for(&state.engine, chain_id).await,
        _ => reattest(&state).await,
    };
    attested.map(Json).map_err(|e| {
        eprintln!("keelson-engine: attestation refresh failed: {e}");
        Problem::new(StatusCode::BAD_GATEWAY, "attestation")
    })
}
