//! TLSNotary sessions over public product endpoints.
//!
//! The prover fetches one JSON product endpoint over TLS with the notary as the other party of
//! the session, reveals the request, the status line and the headers, and commits to one range of
//! the body as `SHA-256(range ‖ blinder)`. The notary checks what [`policy`] allows and returns
//! the server name, the request target and the commitment, which leg A signs as a `WebFact`.
//!
//! MPC-TLS is the default; with Proxy-TLS the notary relays the TLS traffic and dials the server
//! itself, which costs less when the round trips between the parties are slow.

#[cfg(feature = "prover")]
pub mod notary;
pub mod policy;

use std::future::IntoFuture;
use std::ops::Range;
use std::time::Duration;

use http_body_util::Empty;
use hyper::body::Bytes;
use hyper::{Request, StatusCode, Uri};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use tlsn::Session;
use tlsn::config::prove::ProveConfig;
use tlsn::config::prover::ProverConfig;
use tlsn::config::tls::TlsClientConfig;
use tlsn::config::tls_commit::mpc::MpcTlsConfig;
use tlsn::config::tls_commit::proxy::ProxyTlsConfig;
use tlsn::config::verifier::VerifierConfig;
use tlsn::connection::{DnsName, ServerName};
use tlsn::hash::HashAlgId;
use tlsn::prover::{Prover, TlsConnection, state};
use tlsn::transcript::{
    Direction, TranscriptCommitConfig, TranscriptCommitment, TranscriptCommitmentKind,
    TranscriptSecret,
};
use tlsn::verifier::{VerifierCommitStart, VerifierOutput};
use tlsn::webpki::RootCertStore;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::compat::{FuturesAsyncReadCompatExt, TokioAsyncReadCompatExt};
use tokio_util::task::AbortOnDropHandle;

pub use policy::Refusal;

/// How long the notary waits to reach the server in Proxy-TLS.
const DIAL_TIMEOUT: Duration = Duration::from_secs(5);

/// The protocol a session ran.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Mpc,
    Proxy,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("refused: {0}")]
    Refused(#[from] Refusal),
    #[error("url")]
    Url,
    #[error("range")]
    Range,
    #[error("status {0}")]
    Status(StatusCode),
    #[error("tlsn: {0}")]
    Tlsn(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("notary refused: {0}")]
    Notary(String),
}

fn tlsn_err(e: impl std::fmt::Display) -> Error {
    Error::Tlsn(e.to_string())
}

/// What the notary learned from a session it accepted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notarized {
    pub server_name: String,
    /// The request target: path and query.
    pub target: String,
    /// `SHA-256(range ‖ blinder)` of the committed body range.
    pub commitment: [u8; 32],
    pub mode: Mode,
}

/// What the prover keeps from a session: the committed range and the secret that opens it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proven {
    pub server_name: String,
    pub target: String,
    pub mode: Mode,
    /// The response as received: status line, headers and body.
    pub response: Vec<u8>,
    /// The committed range of `response`.
    pub range: Range<usize>,
    pub commitment: [u8; 32],
    pub blinder: [u8; 16],
}

/// Runs the notary's side of one session over `io` and returns what it accepted, or why
/// [`policy`] refused it, with `io` back for the answer.
pub async fn notarize<Io>(io: Io) -> Result<(Result<Notarized, Refusal>, Io), Error>
where
    Io: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let session = Session::new(io.compat());
    let (driver, mut handle) = session.split();
    // Aborted with the session on any early return, so a stalled prover holds nothing.
    let driver = AbortOnDropHandle::new(tokio::spawn(driver));
    let config = VerifierConfig::builder()
        .root_store(RootCertStore::mozilla())
        .build()
        .map_err(tlsn_err)?;
    let verifier = handle.new_verifier(config).map_err(tlsn_err)?;
    let (verifier, mode) = match verifier.commit().await.map_err(tlsn_err)? {
        VerifierCommitStart::Mpc(v) => {
            let c = v.config();
            if c.max_sent_data() > policy::MAX_SENT
                || c.max_recv_data() > policy::MAX_RECV
                || c.max_recv_data_online() > policy::MAX_RECV
                || c.max_sent_records() > Some(policy::MAX_SENT_RECORDS)
                || c.max_recv_records_online() > Some(policy::MAX_RECV_RECORDS_ONLINE)
            {
                v.reject(Some("limits")).await.map_err(tlsn_err)?;
                return Err(Refusal::Request.into());
            }
            let v = v.accept().await.map_err(tlsn_err)?;
            (v.run().await.map_err(tlsn_err)?, Mode::Mpc)
        }
        VerifierCommitStart::Proxy(v) => {
            let host = v.config().server_name().as_str().to_owned();
            let server = match dial(&host).await {
                Ok(s) => s,
                Err(e) => {
                    v.reject(Some("server")).await.map_err(tlsn_err)?;
                    return Err(e);
                }
            };
            let v = v.accept().await.map_err(tlsn_err)?;
            (v.run(server.compat()).await.map_err(tlsn_err)?, Mode::Proxy)
        }
    };
    let verifier = verifier.verify().await.map_err(tlsn_err)?;
    if !verifier.request().server_identity() {
        verifier
            .reject(Some("server identity"))
            .await
            .map_err(tlsn_err)?
            .close()
            .await
            .map_err(tlsn_err)?;
        return Err(Refusal::Server.into());
    }
    let (output, verifier) = verifier.accept().await.map_err(tlsn_err)?;
    verifier.close().await.map_err(tlsn_err)?;
    handle.close();
    let io = driver
        .await
        .map_err(tlsn_err)?
        .map_err(tlsn_err)?
        .into_inner();
    Ok((check(output, mode), io))
}

fn check(output: VerifierOutput, mode: Mode) -> Result<Notarized, Refusal> {
    let VerifierOutput {
        server_name,
        transcript,
        transcript_commitments,
        ..
    } = output;
    let Some(ServerName::Dns(server_name)) = server_name else {
        return Err(Refusal::Server);
    };
    let server_name = server_name.as_str().to_owned();
    let transcript = transcript.ok_or(Refusal::Request)?;
    let sent_len = transcript.len_sent();
    // Proxy-TLS sets no limits up front; the transcript is held to the MPC-TLS ones.
    if sent_len > policy::MAX_SENT || transcript.len_received() > policy::MAX_RECV {
        return Err(Refusal::Response);
    }
    if transcript.sent_authed().len() != sent_len || !transcript.sent_authed().contains(&0) {
        return Err(Refusal::Request);
    }
    let target = policy::check_request(transcript.sent_unsafe(), &server_name)?;
    let revealed = transcript
        .received_authed()
        .iter()
        .next()
        .filter(|r| r.start == 0)
        .ok_or(Refusal::Response)?;
    let body_start = policy::body_start(&transcript.received_unsafe()[revealed.clone()])?;
    let mut hashes = transcript_commitments.iter().filter_map(|c| match c {
        TranscriptCommitment::Hash(h) => Some(h),
        _ => None,
    });
    let (Some(hash), None) = (hashes.next(), hashes.next()) else {
        return Err(Refusal::Commitment);
    };
    let mut ranges = hash.idx.iter();
    let (Some(range), None) = (ranges.next(), ranges.next()) else {
        return Err(Refusal::Commitment);
    };
    if hash.direction != Direction::Received || hash.hash.alg != HashAlgId::SHA256 {
        return Err(Refusal::Commitment);
    }
    policy::check_range(&range, body_start, transcript.len_received())?;
    let commitment: [u8; 32] = hash
        .hash
        .value
        .as_bytes()
        .try_into()
        .map_err(|_| Refusal::Commitment)?;
    Ok(Notarized {
        server_name,
        target,
        commitment,
        mode,
    })
}

/// Dials `host` on port 443 at a public address, so neither party reaches a private network.
async fn dial(host: &str) -> Result<tokio::net::TcpStream, Error> {
    let addrs = tokio::time::timeout(DIAL_TIMEOUT, tokio::net::lookup_host((host, 443)))
        .await
        .map_err(|_| Refusal::Server)?
        .map_err(|_| Refusal::Server)?;
    let addr = addrs
        .into_iter()
        .find(|a| policy::is_public(a.ip()))
        .ok_or(Refusal::Server)?;
    tokio::time::timeout(DIAL_TIMEOUT, tokio::net::TcpStream::connect(addr))
        .await
        .map_err(|_| Refusal::Server)?
        .map_err(Error::Io)
}

/// Runs the prover's side of one session over `notary`: fetches `url` (an `https` URL) and
/// commits to the body, or with `anchor` to the smallest JSON object in the body that contains
/// it. Returns what it proved, with `notary` back for the notary's answer.
pub async fn prove<Io>(
    notary: Io,
    url: &str,
    anchor: Option<&str>,
    mode: Mode,
) -> Result<(Proven, Io), Error>
where
    Io: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let uri: Uri = url.parse().map_err(|_| Error::Url)?;
    if uri.scheme_str() != Some("https") || uri.port().is_some_and(|p| p.as_u16() != 443) {
        return Err(Error::Url);
    }
    let host = uri.host().ok_or(Error::Url)?.to_ascii_lowercase();
    if host.ends_with('.') {
        return Err(Error::Url);
    }
    let target = uri.path_and_query().map_or("/", |p| p.as_str()).to_owned();
    let dns = DnsName::try_from(host.as_str()).map_err(|_| Error::Url)?;
    let tls = TlsClientConfig::builder()
        .server_name(ServerName::Dns(dns.clone()))
        .root_store(RootCertStore::mozilla())
        .build()
        .map_err(tlsn_err)?;

    let session = Session::new(notary.compat());
    let (driver, mut handle) = session.split();
    let driver = AbortOnDropHandle::new(tokio::spawn(driver));
    let prover = handle
        .new_prover(ProverConfig::builder().build().map_err(tlsn_err)?)
        .map_err(tlsn_err)?;
    let prover = match mode {
        Mode::Mpc => {
            let config = MpcTlsConfig::builder()
                .max_sent_data(policy::MAX_SENT)
                .max_recv_data(policy::MAX_RECV)
                .build()
                .map_err(tlsn_err)?;
            let prover = prover.commit(config).await.map_err(tlsn_err)?;
            let server = dial(&host).await?;
            let (conn, prover) = prover.connect(tls, server.compat()).map_err(tlsn_err)?;
            fetch(prover, conn, &host, &target).await?
        }
        Mode::Proxy => {
            let config = ProxyTlsConfig::builder()
                .server_name(dns)
                .build()
                .map_err(tlsn_err)?;
            let prover = prover.commit(config).await.map_err(tlsn_err)?;
            let (conn, prover) = prover.connect(tls).map_err(tlsn_err)?;
            fetch(prover, conn, &host, &target).await?
        }
    };
    let mut prover = prover;

    let response = prover.transcript().received().to_vec();
    let body_start = policy::body_start(&response).map_err(|_| Error::Range)?;
    let range = match anchor {
        None => body_start..response.len(),
        Some(a) => {
            let r =
                policy::object_with(&response[body_start..], a.as_bytes()).ok_or(Error::Range)?;
            body_start + r.start..body_start + r.end
        }
    };
    if range.is_empty() {
        return Err(Error::Range);
    }
    let mut commit = TranscriptCommitConfig::builder(prover.transcript());
    commit.default_kind(TranscriptCommitmentKind::Hash {
        alg: HashAlgId::SHA256,
    });
    commit.commit_recv(&range).map_err(tlsn_err)?;
    let mut config = ProveConfig::builder(prover.transcript());
    config.server_identity();
    config.reveal_sent_all().map_err(tlsn_err)?;
    config.reveal_recv(&(0..body_start)).map_err(tlsn_err)?;
    config.transcript_commit(commit.build().map_err(tlsn_err)?);
    let output = prover
        .prove(&config.build().map_err(tlsn_err)?)
        .await
        .map_err(tlsn_err)?;
    prover.close().await.map_err(tlsn_err)?;
    handle.close();
    let notary = driver
        .await
        .map_err(tlsn_err)?
        .map_err(tlsn_err)?
        .into_inner();

    let commitment = output
        .transcript_commitments
        .iter()
        .find_map(|c| match c {
            TranscriptCommitment::Hash(h) => h.hash.value.as_bytes().try_into().ok(),
            _ => None,
        })
        .ok_or(Error::Range)?;
    let blinder = output
        .transcript_secrets
        .iter()
        .find_map(|s| match s {
            TranscriptSecret::Hash(h) => h.blinder.as_bytes().try_into().ok(),
            _ => None,
        })
        .ok_or(Error::Range)?;
    Ok((
        Proven {
            server_name: host,
            target,
            mode,
            response,
            range,
            commitment,
            blinder,
        },
        notary,
    ))
}

/// Sends one public `GET` over the session's TLS connection and waits for the whole response.
async fn fetch<S>(
    prover: Prover<state::Connected<S>>,
    conn: TlsConnection,
    host: &str,
    target: &str,
) -> Result<Prover<state::Committed>, Error>
where
    S: futures::AsyncRead + futures::AsyncWrite + Send + Unpin + 'static,
{
    let task = AbortOnDropHandle::new(tokio::spawn(prover.into_future()));
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(TokioIo::new(conn.compat()))
            .await
            .map_err(tlsn_err)?;
    tokio::spawn(connection);
    let request = Request::get(target)
        .header("host", host)
        .header("accept", "application/json")
        .header("accept-encoding", "identity")
        .header("connection", "close")
        .header(
            "user-agent",
            concat!("keelson-prover/", env!("CARGO_PKG_VERSION")),
        )
        .body(Empty::<Bytes>::new())
        .map_err(|_| Error::Url)?;
    let response = sender.send_request(request).await.map_err(tlsn_err)?;
    if response.status() != StatusCode::OK {
        return Err(Error::Status(response.status()));
    }
    // Read the body to its end so the whole response is in the transcript.
    http_body_util::BodyExt::collect(response.into_body())
        .await
        .map_err(tlsn_err)?;
    task.await.map_err(tlsn_err)?.map_err(tlsn_err)
}
