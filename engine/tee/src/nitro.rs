//! Leg B in an AWS Nitro Enclave. The enclave has no network: it is served over vsock, takes its
//! configuration once in `POST /v1/boot`, and attests its signer through the Nitro Secure Module.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use alloy_primitives::Address;
use aws_nitro_enclaves_nsm_api::api::{Request as NsmRequest, Response as NsmResponse};
use aws_nitro_enclaves_nsm_api::driver::{nsm_exit, nsm_init, nsm_process_request};
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use keelson_mandate::Jwk;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use time::OffsetDateTime;
use tokio::sync::OnceCell;
use tokio_vsock::{VMADDR_CID_ANY, VsockAddr, VsockListener};
use tower::ServiceExt;

use crate::server::{ATTESTATION_MAX_AGE, AppState, BODY_LIMIT, Problem, parse};
use crate::wire::{Block, Hex32};
use crate::{Engine, EngineConfig, SignerBinding, TeeKind, report_data};

/// The kernel's selection of the entropy source behind `getrandom`.
const RNG_CURRENT: &str = "/sys/class/misc/hw_random/rng_current";
/// The Nitro Secure Module's hardware random number generator.
const HWRNG: &str = "nsm-hwrng";
/// Where the kernel lists its PTP hardware clocks.
#[cfg(target_os = "linux")]
const PTP_CLASS: &str = "/sys/class/ptp";
/// The clock `ptp_kvm` registers: the parent instance's wall clock, read from the hypervisor.
const KVM_PTP: &str = "KVM virtual PTP";

/// Why the enclave could not boot or attest.
#[derive(Debug)]
pub enum NitroError {
    /// The kernel does not draw its entropy from the NSM.
    Entropy(String),
    /// The hypervisor's PTP clock cannot be read.
    Clock(String),
    /// `/dev/nsm` could not be opened or refused the request.
    Nsm(String),
    /// The attestation document is not one for the report data it was asked for.
    Evidence(&'static str),
    /// The binding cannot be computed; see [`crate::Error`].
    Binding(crate::Error),
}

impl fmt::Display for NitroError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Entropy(current) => write!(f, "the hardware rng is {current:?}, not {HWRNG:?}"),
            Self::Clock(e) => write!(f, "host clock: {e}"),
            Self::Nsm(e) => write!(f, "nsm: {e}"),
            Self::Evidence(what) => write!(f, "the attestation document has the wrong {what}"),
            Self::Binding(e) => write!(f, "binding: {e}"),
        }
    }
}

impl std::error::Error for NitroError {}

/// Fails unless the kernel draws its entropy from the NSM, which seeds the signer's key.
pub fn check_entropy() -> Result<(), NitroError> {
    let current = std::fs::read_to_string(RNG_CURRENT)
        .map_err(|e| NitroError::Entropy(format!("unreadable: {e}")))?;
    match current.trim() {
        HWRNG => Ok(()),
        other => Err(NitroError::Entropy(other.into())),
    }
}

/// The hypervisor's PTP clock, opened by [`open_host_clock`].
#[cfg(target_os = "linux")]
static HOST_CLOCK: std::sync::OnceLock<std::fs::File> = std::sync::OnceLock::new();

/// The device of the `ptp_kvm` clock among the PTP clocks listed under `class`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn kvm_ptp_device(class: &Path) -> Option<PathBuf> {
    std::fs::read_dir(class).ok()?.flatten().find_map(|entry| {
        let name = std::fs::read_to_string(entry.path().join("clock_name")).ok()?;
        (name.trim() == KVM_PTP).then(|| Path::new("/dev").join(entry.file_name()))
    })
}

/// Opens the hypervisor's PTP clock, which [`host_now`] reads.
///
/// An enclave's clock is set when it starts and is not synchronized afterwards, so it drifts from
/// the parent's. The `ptp_kvm` clock reads the parent's wall clock through the hypervisor each
/// time, which is how AWS recommends an enclave keeps its time.
#[cfg(target_os = "linux")]
pub fn open_host_clock() -> Result<PathBuf, NitroError> {
    let device = kvm_ptp_device(Path::new(PTP_CLASS))
        .ok_or_else(|| NitroError::Clock(format!("no {KVM_PTP:?} clock in {PTP_CLASS}")))?;
    let clock = std::fs::File::open(&device)
        .map_err(|e| NitroError::Clock(format!("{}: {e}", device.display())))?;
    read_ptp(&clock).map_err(|e| NitroError::Clock(format!("{}: {e}", device.display())))?;
    let _ = HOST_CLOCK.set(clock);
    Ok(device)
}

#[cfg(not(target_os = "linux"))]
pub fn open_host_clock() -> Result<PathBuf, NitroError> {
    Err(NitroError::Clock(
        "PTP clocks are read on Linux only".into(),
    ))
}

#[cfg(target_os = "linux")]
fn read_ptp(clock: &std::fs::File) -> std::io::Result<OffsetDateTime> {
    use rustix::time::{DynamicClockId, clock_gettime_dynamic};
    use std::os::fd::AsFd;
    let t = clock_gettime_dynamic(DynamicClockId::Dynamic(clock.as_fd()))?;
    OffsetDateTime::from_unix_timestamp_nanos(
        i128::from(t.tv_sec) * 1_000_000_000 + i128::from(t.tv_nsec),
    )
    .map_err(std::io::Error::other)
}

/// The parent's wall clock, from the clock [`open_host_clock`] opened; the enclave's own clock
/// when none is open or a read fails.
pub fn host_now() -> OffsetDateTime {
    #[cfg(target_os = "linux")]
    if let Some(now) = HOST_CLOCK.get().and_then(|clock| read_ptp(clock).ok()) {
        return now;
    }
    OffsetDateTime::now_utc()
}

/// A session with the Nitro Secure Module on `/dev/nsm`.
struct Nsm(i32);

impl Nsm {
    fn open() -> Result<Self, NitroError> {
        match nsm_init() {
            fd if fd >= 0 => Ok(Self(fd)),
            _ => Err(NitroError::Nsm("cannot open /dev/nsm".into())),
        }
    }

    /// The signed COSE_Sign1 attestation document over the three caller-chosen fields.
    fn attest(
        &self,
        user_data: &[u8],
        nonce: &[u8],
        public_key: &[u8],
    ) -> Result<Vec<u8>, NitroError> {
        let request = NsmRequest::Attestation {
            user_data: Some(ByteBuf::from(user_data)),
            nonce: Some(ByteBuf::from(nonce)),
            public_key: Some(ByteBuf::from(public_key)),
        };
        match nsm_process_request(self.0, request) {
            NsmResponse::Attestation { document } => Ok(document),
            NsmResponse::Error(code) => Err(NitroError::Nsm(format!("{code:?}"))),
            _ => Err(NitroError::Nsm("unexpected response".into())),
        }
    }
}

impl Drop for Nsm {
    fn drop(&mut self) {
        nsm_exit(self.0);
    }
}

/// The attested signer, as `GET /v1/attestation` serves it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attestation {
    /// Always `nitro`.
    pub tee: String,
    /// The attestation document, a COSE_Sign1, in standard base64. Its `user_data` is
    /// [`report_data`], its `public_key` the signer's SEC1 key and its `nonce` the block hash.
    pub document: String,
    pub binding: SignerBinding,
    /// The block whose hash is the second half of `report_data`. The enclave has no network, so
    /// the parent supplies it and a verifier checks it against the chain.
    pub block: Block,
}

/// The payload of a COSE_Sign1 document, which holds the CBOR attestation document.
pub fn cose_payload(cose: &[u8]) -> Option<Vec<u8>> {
    match serde_cbor::from_slice::<serde_cbor::Value>(cose).ok()? {
        serde_cbor::Value::Array(parts) => match parts.get(2)? {
            serde_cbor::Value::Bytes(payload) => Some(payload.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// What the routes of a booted enclave share: the NSM session and the attestation served.
pub(crate) struct Nitro {
    nsm: Arc<Nsm>,
    served: RwLock<(Attestation, OffsetDateTime)>,
}

impl Nitro {
    fn new(nsm: Arc<Nsm>, attestation: Attestation, at: OffsetDateTime) -> Self {
        Self {
            nsm,
            served: RwLock::new((attestation, at)),
        }
    }
}

/// Attests `engine`'s signer for `chain_id` over `block` of that chain and checks the NSM's
/// document says so.
fn attest(
    nsm: &Nsm,
    engine: &Engine,
    chain_id: u64,
    block: Block,
) -> Result<Attestation, NitroError> {
    let binding = engine.binding_for(chain_id).map_err(NitroError::Binding)?;
    let data = report_data(&binding, block.hash.0).map_err(NitroError::Binding)?;
    let key = engine.signer_public_key();
    let document = nsm.attest(&data, &block.hash.0, &key)?;

    let payload = cose_payload(&document).ok_or(NitroError::Evidence("structure"))?;
    let doc = serde_cbor::from_slice::<serde_cbor::Value>(&payload)
        .map_err(|_| NitroError::Evidence("payload"))?;
    let field = |name: &str| match &doc {
        serde_cbor::Value::Map(map) => {
            map.get(&serde_cbor::Value::Text(name.into()))
                .and_then(|v| match v {
                    serde_cbor::Value::Bytes(bytes) => Some(bytes.as_slice()),
                    _ => None,
                })
        }
        _ => None,
    };
    if field("user_data") != Some(&data[..]) {
        return Err(NitroError::Evidence("user_data"));
    }
    if field("nonce") != Some(&block.hash.0[..]) {
        return Err(NitroError::Evidence("nonce"));
    }
    if field("public_key") != Some(&key[..]) {
        return Err(NitroError::Evidence("public_key"));
    }
    Ok(Attestation {
        tee: "nitro".into(),
        document: STANDARD.encode(&document),
        binding,
        block,
    })
}

/// The one configuration message of an enclave.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BootRequest {
    config: BootConfig,
    /// The hex SHA-256 of the bearer token; the token itself never reaches the enclave.
    token_sha256: Hex32,
    block: Block,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BootConfig {
    chain_id: u64,
    bond_vault: Address,
    verifying_contract: Address,
    oci_digest: String,
    canonicalizer: String,
    /// The user credential issuer's public JWK: the enclave holds no root to derive it from.
    issuer: serde_json::Value,
    origin: String,
}

#[derive(Serialize)]
struct Booted {
    signer: Address,
}

fn invalid(what: &'static str) -> Problem {
    Problem::new(StatusCode::UNPROCESSABLE_ENTITY, what)
}

impl BootConfig {
    fn engine(self) -> Result<Engine, Problem> {
        keelson_core::domain(self.chain_id, self.verifying_contract)
            .map_err(|_| invalid("bad_request"))?;
        let issuer = Jwk::from_value(&self.issuer).map_err(|_| invalid("bad_request"))?;
        Ok(Engine::new(
            EngineConfig {
                chain_id: self.chain_id,
                bond_vault: self.bond_vault,
                verifying_contract: self.verifying_contract,
                oci_digest: self.oci_digest,
                canonicalizer: self.canonicalizer,
                tee_kind: TeeKind::Nitro,
                issuer: Some(issuer),
                origin: self.origin,
            },
            None,
        ))
    }
}

/// An enclave that has not been booted answers `not_ready`; after `POST /v1/boot` its routes are
/// those of [`crate::server::router`].
struct Enclave {
    nsm: Arc<Nsm>,
    booted: OnceCell<(Router, Address)>,
}

/// The routes of an enclave before and after its boot.
fn app(nsm: Arc<Nsm>) -> Router {
    let enclave = Arc::new(Enclave {
        nsm,
        booted: OnceCell::new(),
    });
    Router::new()
        .route(
            "/v1/boot",
            post(boot).layer(DefaultBodyLimit::max(BODY_LIMIT)),
        )
        .fallback(forward)
        .with_state(enclave)
}

async fn forward(State(enclave): State<Arc<Enclave>>, request: Request) -> Response {
    match enclave.booted.get() {
        Some((router, _)) => match router.clone().oneshot(request).await {
            Ok(response) => response,
            Err(never) => match never {},
        },
        None => Problem::new(StatusCode::SERVICE_UNAVAILABLE, "not_ready").into_response(),
    }
}

async fn boot(
    State(enclave): State<Arc<Enclave>>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<Booted>, Problem> {
    let request: BootRequest = parse(body)?;
    let first = AtomicBool::new(false);
    let (_, signer) = enclave
        .booted
        .get_or_try_init(|| async {
            first.store(true, Ordering::Relaxed);
            let engine = request.config.engine()?;
            let state = AppState::new(engine, request.token_sha256.0).with_clock(host_now);
            let nsm = enclave.nsm.clone();
            let block = request.block;
            let state = tokio::task::spawn_blocking(move || {
                let chain_id = state.engine().config().chain_id;
                let attestation = attest(&nsm, state.engine(), chain_id, block)?;
                let served = Nitro::new(nsm, attestation, state.now());
                Ok::<_, NitroError>(state.with_nitro(served))
            })
            .await
            .map_err(|_| Problem::new(StatusCode::INTERNAL_SERVER_ERROR, "internal"))?
            .map_err(|e| {
                eprintln!("keelson-engine: {e}");
                Problem::new(StatusCode::BAD_GATEWAY, "attestation")
            })?;
            let signer = state.engine().signer();
            Ok::<_, Problem>((crate::server::router(Arc::new(state)), signer))
        })
        .await?;
    if !first.load(Ordering::Relaxed) {
        return Err(Problem::new(StatusCode::CONFLICT, "already_booted"));
    }
    Ok(Json(Booted { signer: *signer }))
}

pub(crate) async fn attestation(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Attestation>, Problem> {
    let served = state
        .nitro()
        .served
        .read()
        .unwrap_or_else(|e| e.into_inner());
    if state.now() - served.1 > ATTESTATION_MAX_AGE {
        return Err(Problem::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "attestation_stale",
        ));
    }
    Ok(Json(served.0.clone()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Refresh {
    block: Block,
    /// Another chain than the enclave's own: the document is made for it and returned, and the
    /// served one stays.
    #[serde(default)]
    chain_id: Option<u64>,
}

/// Attests the same signer over a newer block than the one served, or over `block` of another
/// chain.
pub(crate) async fn refresh(
    State(state): State<Arc<AppState>>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<Attestation>, Problem> {
    let Refresh { block, chain_id } = parse(body)?;
    let own = state.engine().config().chain_id;
    let chain_id = chain_id.unwrap_or(own);
    if chain_id != own {
        let worker = state.clone();
        return tokio::task::spawn_blocking(move || {
            attest(&worker.nitro().nsm, worker.engine(), chain_id, block)
        })
        .await
        .map_err(|_| Problem::new(StatusCode::INTERNAL_SERVER_ERROR, "internal"))?
        .map(Json)
        .map_err(|e| {
            eprintln!("keelson-engine: attestation for chain {chain_id} failed: {e}");
            Problem::new(StatusCode::BAD_GATEWAY, "attestation")
        });
    }
    let at = state.now();
    let current = state
        .nitro()
        .served
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .0
        .block;
    if block.number <= current.number {
        return Err(invalid("bad_request"));
    }
    let worker = state.clone();
    let fresh = tokio::task::spawn_blocking(move || {
        attest(&worker.nitro().nsm, worker.engine(), own, block)
    })
    .await
    .map_err(|_| Problem::new(StatusCode::INTERNAL_SERVER_ERROR, "internal"))?
    .map_err(|e| {
        eprintln!("keelson-engine: attestation refresh failed: {e}");
        Problem::new(StatusCode::BAD_GATEWAY, "attestation")
    })?;
    let mut served = state
        .nitro()
        .served
        .write()
        .unwrap_or_else(|e| e.into_inner());
    if fresh.block.number >= served.0.block.number {
        *served = (fresh, at);
    }
    Ok(Json(served.0.clone()))
}

/// Serves an unbooted enclave on vsock `port`, from any CID, until the process ends.
pub async fn serve(port: u32) -> Result<(), String> {
    check_entropy().map_err(|e| e.to_string())?;
    eprintln!("keelson-engine: entropy from {HWRNG}");
    let clock = open_host_clock().map_err(|e| e.to_string())?;
    eprintln!("keelson-engine: time from {KVM_PTP} at {}", clock.display());
    let nsm = Arc::new(Nsm::open().map_err(|e| e.to_string())?);
    let listener = VsockListener::bind(VsockAddr::new(VMADDR_CID_ANY, port))
        .map_err(|e| format!("cannot listen on vsock port {port}: {e}"))?;
    axum::serve(listener, app(nsm))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::kvm_ptp_device;

    #[test]
    fn finds_the_hypervisor_ptp_clock_by_name() {
        let class = std::env::temp_dir().join(format!("keelson-ptp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&class);
        for (device, name) in [("ptp0", "ENA PTP\n"), ("ptp1", "KVM virtual PTP\n")] {
            std::fs::create_dir_all(class.join(device)).unwrap();
            std::fs::write(class.join(device).join("clock_name"), name).unwrap();
        }
        assert_eq!(
            kvm_ptp_device(&class).as_deref(),
            Some(Path::new("/dev/ptp1"))
        );
        std::fs::remove_dir_all(class.join("ptp1")).unwrap();
        assert_eq!(kvm_ptp_device(&class), None);
        assert_eq!(kvm_ptp_device(&class.join("missing")), None);
        std::fs::remove_dir_all(&class).unwrap();
    }
}
