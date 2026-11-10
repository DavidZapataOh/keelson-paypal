//! The prover's connection to the notary on leg A: `GET /v1/notary` upgraded to a raw stream
//! (`Upgrade: keelson-notary`), over which the session runs and the notary then answers with the
//! signed `WebFact` as one JSON object.

use std::sync::Arc;

use http_body_util::Empty;
use hyper::body::Bytes;
use hyper::upgrade::Upgraded;
use hyper::{Request, StatusCode, Uri};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};

use crate::Error;

/// The `Upgrade` protocol token of a notary session.
pub const PROTOCOL: &str = "keelson-notary";

/// The largest answer the notary sends, in bytes.
const MAX_ANSWER: u64 = 4096;

/// Opens a session stream to the notary at `base` (`https://…`, or `http://…` on a local
/// network), authenticated with the bearer `token`.
pub async fn connect(base: &str, token: &str) -> Result<TokioIo<Upgraded>, Error> {
    let uri: Uri = base.parse().map_err(|_| Error::Url)?;
    let host = uri.host().ok_or(Error::Url)?.to_owned();
    let tls = match uri.scheme_str() {
        Some("https") => true,
        Some("http") => false,
        _ => return Err(Error::Url),
    };
    let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });
    let path = format!("{}/v1/notary", uri.path().trim_end_matches('/'));
    let tcp = tokio::net::TcpStream::connect((host.as_str(), port)).await?;
    tcp.set_nodelay(true)?;
    let request = Request::get(path)
        .header("host", &host)
        .header("authorization", format!("Bearer {token}"))
        .header("connection", "upgrade")
        .header("upgrade", PROTOCOL)
        .body(Empty::<Bytes>::new())
        .map_err(|_| Error::Url)?;
    if tls {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::Tlsn(e.to_string()))?
        .with_root_certificates(roots)
        .with_no_client_auth();
        let name = rustls::pki_types::ServerName::try_from(host).map_err(|_| Error::Url)?;
        let stream = tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(name, tcp)
            .await?;
        upgrade(stream, request).await
    } else {
        upgrade(tcp, request).await
    }
}

async fn upgrade<S>(io: S, request: Request<Empty<Bytes>>) -> Result<TokioIo<Upgraded>, Error>
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(io))
        .await
        .map_err(|e| Error::Tlsn(e.to_string()))?;
    tokio::spawn(connection.with_upgrades());
    let response = sender
        .send_request(request)
        .await
        .map_err(|e| Error::Tlsn(e.to_string()))?;
    if response.status() != StatusCode::SWITCHING_PROTOCOLS {
        return Err(Error::Status(response.status()));
    }
    let upgraded = hyper::upgrade::on(response)
        .await
        .map_err(|e| Error::Tlsn(e.to_string()))?;
    Ok(TokioIo::new(upgraded))
}

/// Reads the notary's answer once the session is over: the signed `WebFact`, or the code of
/// the refusal as [`Error::Notary`].
pub async fn answer<Io: AsyncRead + Unpin>(io: Io) -> Result<serde_json::Value, Error> {
    let mut bytes = Vec::new();
    io.take(MAX_ANSWER).read_to_end(&mut bytes).await?;
    let answer: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| Error::Notary("no answer".into()))?;
    if let Some(code) = answer.get("error") {
        return Err(Error::Notary(code.as_str().unwrap_or_default().to_owned()));
    }
    Ok(answer)
}
