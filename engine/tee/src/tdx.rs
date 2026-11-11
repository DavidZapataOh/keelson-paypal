//! Leg A on Intel TDX. The dstack guest agent, through its v1 API on `/var/run/dstack.sock`,
//! gives the engine its KMS root and attests the signer's [`report_data`].

use std::fmt;
use std::path::PathBuf;

use alloy_primitives::hex;
use axum::body::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, StatusCode, header};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::net::UnixStream;
use zeroize::Zeroizing;

use crate::logsign::{self, LogKey};
pub use crate::wire::Block;
use crate::{Engine, EngineConfig, Error, Root, SignerBinding, chain, report_data};

/// The guest agent's socket inside the CVM.
pub const SOCKET: &str = "/var/run/dstack.sock";
/// The domain of the KMS root; the only key the engine asks the KMS for.
pub const ROOT_DOMAIN: &str = "keelson/root/v1";
/// Where the report data sits in a TDX quote (v4 and v5): the 48-byte header, then 520 bytes of
/// the TD report before `REPORTDATA`.
pub const QUOTE_REPORT_DATA: std::ops::Range<usize> = 568..632;

/// A guest agent call that failed.
#[derive(Debug)]
pub enum DstackError {
    /// The socket could not be reached or the HTTP exchange failed.
    Transport(String),
    /// The agent has no `/v1` surface: it predates dstack 0.6.
    NoV1,
    /// The agent refused the call, with its message.
    Agent(StatusCode, String),
    /// The answer is not the shape the call returns.
    Malformed(&'static str),
}

impl fmt::Display for DstackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(e) => write!(f, "dstack agent unreachable: {e}"),
            Self::NoV1 => f.write_str("the dstack agent does not serve the v1 API"),
            Self::Agent(status, message) => write!(f, "dstack agent: {status}: {message}"),
            Self::Malformed(what) => write!(f, "malformed dstack response: {what}"),
        }
    }
}

impl std::error::Error for DstackError {}

/// A client of the guest agent's `dstack.guest.v1` API.
#[derive(Clone, Debug)]
pub struct Dstack {
    socket: PathBuf,
}

/// The application's identity, as the agent reports it. Unattested: a verifier confirms it
/// against the attestation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Info {
    /// Lowercase hex.
    pub app_id: String,
    /// `sha256` of the deployed `app-compose.json`, lowercase hex.
    pub compose_hash: String,
}

impl Dstack {
    pub fn new(socket: impl Into<PathBuf>) -> Self {
        Self {
            socket: socket.into(),
        }
    }

    /// The socket in `DSTACK_SIMULATOR_ENDPOINT` when set, as the dstack SDKs do, otherwise
    /// [`SOCKET`].
    pub fn from_env() -> Self {
        Self::new(std::env::var_os("DSTACK_SIMULATOR_ENDPOINT").unwrap_or_else(|| SOCKET.into()))
    }

    /// The KMS root: `GetKey` for [`ROOT_DOMAIN`] on secp256k1, whose 32 bytes become the
    /// [`Root`]. Every copy outside the `Root` is wiped.
    pub async fn root(&self) -> Result<Root, DstackError> {
        #[derive(Deserialize)]
        struct Key<'a> {
            key: &'a str,
        }
        let body = self
            .call(
                "GetKey",
                json!({ "domain": ROOT_DOMAIN, "algorithm": "secp256k1" }),
            )
            .await?;
        let key: Key<'_> =
            serde_json::from_slice(&body).map_err(|_| DstackError::Malformed("GetKey"))?;
        let mut root = Zeroizing::new([0; 32]);
        hex::decode_to_slice(key.key, &mut root[..])
            .map_err(|_| DstackError::Malformed("GetKey key"))?;
        Ok(Root::new(&root))
    }

    /// The Ed25519 log key of `origin`: `GetKey` for its domain, with the KMS signature chain
    /// that proves this app derived it. The seed lives only in the returned key.
    pub async fn log_key(&self, origin: &'static str) -> Result<LogKey, DstackError> {
        #[derive(Deserialize)]
        struct Key<'a> {
            key: &'a str,
            signature_chain: Vec<&'a str>,
        }
        let body = self
            .call(
                "GetKey",
                json!({ "domain": logsign::key_domain(origin), "algorithm": "ed25519" }),
            )
            .await?;
        let key: Key<'_> =
            serde_json::from_slice(&body).map_err(|_| DstackError::Malformed("GetKey"))?;
        let mut seed = Zeroizing::new([0; 32]);
        hex::decode_to_slice(key.key, &mut seed[..])
            .map_err(|_| DstackError::Malformed("GetKey key"))?;
        let chain = key
            .signature_chain
            .iter()
            .map(hex::decode)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| DstackError::Malformed("GetKey signature_chain"))?;
        Ok(LogKey::new(origin, &seed, chain))
    }

    /// `IssueCert` for an RA-TLS server certificate: the CVM's attestation in the certificate
    /// (dstack `PHALA_RATLS_ATTESTATION`), bound to a key the agent generates. Returns the PEM
    /// private key and the PEM chain, leaf first.
    pub async fn ra_tls_cert(
        &self,
        alt_names: &[String],
    ) -> Result<(Zeroizing<String>, Vec<String>), DstackError> {
        #[derive(Deserialize)]
        struct Cert {
            key: String,
            certificate_chain: Vec<String>,
        }
        let body = self
            .call(
                "IssueCert",
                json!({
                    "subject": "keelson-engine",
                    "alt_names": alt_names,
                    "usage_ra_tls": true,
                    "usage_server_auth": true,
                    "usage_client_auth": false,
                    "with_app_info": true,
                }),
            )
            .await?;
        let cert: Cert =
            serde_json::from_slice(&body).map_err(|_| DstackError::Malformed("IssueCert"))?;
        Ok((Zeroizing::new(cert.key), cert.certificate_chain))
    }

    /// `Attest` over `report_data`: the versioned attestation, MessagePack V1.
    pub async fn attest(&self, report_data: &[u8; 64]) -> Result<Vec<u8>, DstackError> {
        #[derive(Deserialize)]
        struct Attest {
            attestation: String,
        }
        let body = self
            .call("Attest", json!({ "report_data": hex::encode(report_data) }))
            .await?;
        let attest: Attest =
            serde_json::from_slice(&body).map_err(|_| DstackError::Malformed("Attest"))?;
        hex::decode(attest.attestation).map_err(|_| DstackError::Malformed("Attest attestation"))
    }

    /// `Info`: the app id and compose hash.
    pub async fn info(&self) -> Result<Info, DstackError> {
        #[derive(Deserialize)]
        struct InfoResponse {
            app_id: String,
            compose_hash: String,
        }
        let body = self.call("Info", json!({})).await?;
        let info: InfoResponse =
            serde_json::from_slice(&body).map_err(|_| DstackError::Malformed("Info"))?;
        Ok(Info {
            app_id: info.app_id,
            compose_hash: info.compose_hash,
        })
    }

    /// `Version`: the agent's version.
    pub async fn version(&self) -> Result<String, DstackError> {
        #[derive(Deserialize)]
        struct Version {
            version: String,
        }
        let body = self.call("Version", json!({})).await?;
        serde_json::from_slice::<Version>(&body)
            .map(|v| v.version)
            .map_err(|_| DstackError::Malformed("Version"))
    }

    /// `POST /v1/<method>` with a JSON body; the response body is wiped when dropped.
    async fn call(&self, method: &str, body: Value) -> Result<Zeroizing<Vec<u8>>, DstackError> {
        let transport = |e: &dyn fmt::Display| DstackError::Transport(e.to_string());
        let stream = UnixStream::connect(&self.socket)
            .await
            .map_err(|e| transport(&e))?;
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|e| transport(&e))?;
        tokio::spawn(connection);
        let request = Request::post(format!("/v1/{method}"))
            .header(header::HOST, "dstack")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Full::new(Bytes::from(body.to_string())))
            .map_err(|e| transport(&e))?;
        let response = sender
            .send_request(request)
            .await
            .map_err(|e| transport(&e))?;
        let status = response.status();
        let body = response
            .into_body()
            .collect()
            .await
            .map_err(|e| transport(&e))?;
        // Takes the collected buffer over rather than copying it again.
        let bytes = Zeroizing::new(Vec::from(body.to_bytes()));
        if status.is_success() {
            return Ok(bytes);
        }
        #[derive(Deserialize)]
        struct Refusal {
            error: String,
        }
        match serde_json::from_slice::<Refusal>(&bytes) {
            Ok(r) => Err(DstackError::Agent(status, r.error)),
            Err(_) if status == StatusCode::NOT_FOUND => Err(DstackError::NoV1),
            Err(_) => Err(DstackError::Agent(status, String::new())),
        }
    }
}

/// What a MessagePack V1 attestation carries for Intel TDX.
#[derive(Clone, Debug, PartialEq)]
pub struct Evidence {
    /// The raw TDX quote.
    pub quote: Vec<u8>,
    /// The TDX event log as the guest agent's JSON event log: `imr`, `event_type`, `digest`,
    /// `event`, `event_payload`, with byte strings in lowercase hex.
    pub event_log: Value,
    /// `stack.data.report_data`.
    pub report_data: [u8; 64],
}

/// Reads the quote, event log and report data out of a versioned attestation returned by v1
/// `Attest` on Intel TDX: `{ version: 1, platform: { kind: "tdx", data: { quote, event_log } },
/// stack: { kind, data: { report_data, .. } } }`.
pub fn decode_attestation(bytes: &[u8]) -> Result<Evidence, DstackError> {
    let malformed = DstackError::Malformed;
    let mut reader = bytes;
    let value = rmpv::decode::read_value(&mut reader).map_err(|_| malformed("attestation"))?;
    if !reader.is_empty() {
        return Err(malformed("attestation trailing bytes"));
    }
    if field(&value, "version").and_then(rmpv::Value::as_u64) != Some(1) {
        return Err(malformed("attestation version"));
    }
    let platform = field(&value, "platform").ok_or(malformed("platform"))?;
    if field(platform, "kind").and_then(rmpv::Value::as_str) != Some("tdx") {
        return Err(malformed("platform kind"));
    }
    let data = field(platform, "data").ok_or(malformed("platform data"))?;
    let quote = field(data, "quote")
        .and_then(byte_string)
        .ok_or(malformed("quote"))?;
    let event_log = field(data, "event_log")
        .filter(|log| log.is_array())
        .map(to_json)
        .ok_or(malformed("event log"))?;
    let report_data = field(&value, "stack")
        .and_then(|stack| field(stack, "data"))
        .and_then(|data| field(data, "report_data"))
        .and_then(byte_string)
        .and_then(|bytes| <[u8; 64]>::try_from(bytes).ok())
        .ok_or(malformed("report data"))?;
    Ok(Evidence {
        quote,
        event_log,
        report_data,
    })
}

fn field<'a>(map: &'a rmpv::Value, key: &str) -> Option<&'a rmpv::Value> {
    map.as_map()?
        .iter()
        .find(|(k, _)| k.as_str() == Some(key))
        .map(|(_, v)| v)
}

/// A byte string, which `rmp_serde` writes as either a binary or an array of integers.
fn byte_string(value: &rmpv::Value) -> Option<Vec<u8>> {
    match value {
        rmpv::Value::Binary(bytes) => Some(bytes.clone()),
        rmpv::Value::Array(items) => items
            .iter()
            .map(|b| b.as_u64().and_then(|b| u8::try_from(b).ok()))
            .collect(),
        _ => None,
    }
}

/// MessagePack to JSON, with binaries as lowercase hex.
fn to_json(value: &rmpv::Value) -> Value {
    use rmpv::Value as M;
    match value {
        M::Nil => Value::Null,
        M::Boolean(b) => Value::Bool(*b),
        M::Integer(i) => i
            .as_u64()
            .map(Value::from)
            .or_else(|| i.as_i64().map(Value::from))
            .unwrap_or(Value::Null),
        M::F32(x) => Value::from(f64::from(*x)),
        M::F64(x) => Value::from(*x),
        M::String(s) => s.as_str().map(Value::from).unwrap_or(Value::Null),
        M::Binary(bytes) => Value::from(hex::encode(bytes)),
        M::Array(items) => items.iter().map(to_json).collect(),
        M::Map(entries) => entries
            .iter()
            .filter_map(|(k, v)| Some((k.as_str()?.to_owned(), to_json(v))))
            .collect(),
        M::Ext(..) => Value::Null,
    }
}

/// The attested signer, as `GET /v1/attestation` serves it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Attestation {
    /// Always `tdx`.
    pub tee: String,
    /// The versioned attestation from v1 `Attest`, lowercase hex; `dstack-verifier` takes it as
    /// is.
    pub attestation: String,
    /// The TDX quote inside it, lowercase hex.
    pub quote: String,
    /// The TDX event log inside it.
    pub event_log: Value,
    pub binding: SignerBinding,
    /// The block whose hash is the second half of `report_data`.
    pub block: Block,
    pub app_id: String,
    pub compose_hash: String,
    pub dstack_version: String,
}

/// Why the engine could not boot or attest.
#[derive(Debug)]
pub enum BootError {
    Dstack(DstackError),
    Chain(chain::ChainError),
    /// The RPC serves another chain than the engine's.
    WrongChain {
        expected: u64,
        rpc: u64,
    },
    /// The engine's binding cannot be computed; see [`Error`].
    Binding(Error),
    /// The attestation does not carry the report data it was asked for.
    Evidence,
}

impl fmt::Display for BootError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Dstack(e) => e.fmt(f),
            Self::Chain(e) => e.fmt(f),
            Self::WrongChain { expected, rpc } => {
                write!(f, "the rpc serves chain {rpc}, not {expected}")
            }
            Self::Binding(e) => write!(f, "binding: {e}"),
            Self::Evidence => f.write_str("the attestation does not carry the report data"),
        }
    }
}

impl std::error::Error for BootError {}

impl From<DstackError> for BootError {
    fn from(e: DstackError) -> Self {
        Self::Dstack(e)
    }
}

impl From<chain::ChainError> for BootError {
    fn from(e: chain::ChainError) -> Self {
        Self::Chain(e)
    }
}

/// Boots leg A: the root from the KMS, the engine with it, and its first attestation.
pub async fn boot(config: EngineConfig) -> Result<(Engine, Attestation), BootError> {
    let root = Dstack::from_env().root().await?;
    let engine = Engine::new(config, Some(root));
    let attestation = attest(&engine).await?;
    Ok((engine, attestation))
}

/// Attests `engine`'s signer over the latest block of its own chain.
pub async fn attest(engine: &Engine) -> Result<Attestation, BootError> {
    attest_for(engine, engine.config().chain_id).await
}

/// Attests `engine`'s signer for `chain_id` over the latest block of [`chain::rpc_url_for`].
pub async fn attest_for(engine: &Engine, chain_id: u64) -> Result<Attestation, BootError> {
    let dstack = Dstack::from_env();
    let rpc = chain::rpc_url_for(chain_id);
    let binding = engine.binding_for(chain_id).map_err(BootError::Binding)?;
    let (rpc_chain, (number, hash), info, version) = tokio::try_join!(
        async { Ok::<_, BootError>(chain::chain_id(&rpc).await?) },
        async { Ok(chain::latest_block(&rpc).await?) },
        async { Ok(dstack.info().await?) },
        async { Ok(dstack.version().await?) },
    )?;
    if rpc_chain != binding.chain_id {
        return Err(BootError::WrongChain {
            expected: binding.chain_id,
            rpc: rpc_chain,
        });
    }
    let data = report_data(&binding, hash).map_err(BootError::Binding)?;
    let attestation = dstack.attest(&data).await?;
    let evidence = decode_attestation(&attestation)?;
    if evidence.report_data != data || evidence.quote.get(QUOTE_REPORT_DATA) != Some(&data[..]) {
        return Err(BootError::Evidence);
    }
    Ok(Attestation {
        tee: "tdx".into(),
        attestation: hex::encode(&attestation),
        quote: hex::encode(&evidence.quote),
        event_log: evidence.event_log,
        binding,
        block: Block {
            number,
            hash: crate::wire::Hex(hash),
        },
        app_id: info.app_id,
        compose_hash: info.compose_hash,
        dstack_version: version,
    })
}
