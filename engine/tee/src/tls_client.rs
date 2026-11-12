//! One HTTPS/1.1 exchange over a stream this side opens and whose TLS it terminates, trusting a
//! single pinned root: how leg B reaches PayPal and AWS KMS through its parent's `vsock-proxy`
//! without the parent seeing the traffic.

use std::fmt;
use std::sync::Arc;

use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;

/// Where the connection is opened.
#[derive(Clone, Debug)]
pub enum Connect {
    /// A port of the enclave's parent (CID 3), which a `vsock-proxy` forwards to the host.
    Vsock { cid: u32, port: u32 },
    /// A TCP address.
    Tcp(String),
}

/// A request to send: method, path, headers and body. `Host` is added from the connection.
pub struct Exchange<'a> {
    pub post: bool,
    pub path: &'a str,
    pub headers: Vec<(&'static str, String)>,
    pub body: Bytes,
}

/// The TLS configuration trusting `root` (DER) alone: TLS 1.2 or 1.3.
fn tls_config(root: &'static [u8]) -> Result<Arc<rustls::ClientConfig>, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls::pki_types::CertificateDer::from(root))
        .map_err(|e| e.to_string())?;
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| e.to_string())?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(Arc::new(config))
}

/// Sends `exchange` to `host` over `connect`, with SNI `host` and `root` the only trust anchor,
/// and returns the status and a body of at most `max_body` bytes.
pub async fn send(
    connect: &Connect,
    host: &str,
    root: &'static [u8],
    exchange: Exchange<'_>,
    max_body: usize,
) -> Result<(u16, Vec<u8>), String> {
    let text = |e: &dyn fmt::Display| e.to_string();
    let name = rustls::pki_types::ServerName::try_from(host.to_owned()).map_err(|e| text(&e))?;
    let tls = tokio_rustls::TlsConnector::from(tls_config(root)?);
    let mut request = hyper::Request::builder()
        .method(if exchange.post { "POST" } else { "GET" })
        .uri(exchange.path)
        .header(hyper::header::HOST, host);
    for (name, value) in exchange.headers {
        request = request.header(name, value);
    }
    let request = request
        .body(Full::new(exchange.body))
        .map_err(|e| text(&e))?;
    macro_rules! over {
        ($stream:expr) => {{
            let stream = tls.connect(name, $stream).await.map_err(|e| text(&e))?;
            let (mut sender, connection) =
                hyper::client::conn::http1::handshake(TokioIo::new(stream))
                    .await
                    .map_err(|e| text(&e))?;
            tokio::spawn(connection);
            let response = sender.send_request(request).await.map_err(|e| text(&e))?;
            let status = response.status().as_u16();
            let body = Limited::new(response.into_body(), max_body)
                .collect()
                .await
                .map_err(|_| "the response is too large".to_owned())?;
            Ok((status, body.to_bytes().to_vec()))
        }};
    }
    match connect {
        #[cfg(feature = "nitro")]
        Connect::Vsock { cid, port } => {
            let addr = tokio_vsock::VsockAddr::new(*cid, *port);
            let stream = tokio_vsock::VsockStream::connect(addr)
                .await
                .map_err(|e| text(&e))?;
            over!(stream)
        }
        #[cfg(not(feature = "nitro"))]
        Connect::Vsock { .. } => Err("vsock needs the nitro build".into()),
        Connect::Tcp(addr) => {
            let stream = tokio::net::TcpStream::connect(addr)
                .await
                .map_err(|e| text(&e))?;
            over!(stream)
        }
    }
}
