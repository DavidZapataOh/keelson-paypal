//! Leg A's RA-TLS listener. Its certificate is issued by the dstack agent with the CVM's
//! attestation in it (`IssueCert` with `usage_ra_tls`), and the leg's attested signer signs the
//! certificate's hash, so a client that trusts the signer's attestation (`GET
//! /v1/attestation`) knows it reached this CVM: `GET /v1/log/tls` serves that signature.

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use alloy_primitives::keccak256;
use rustls::ServerConfig;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use sha2::{Digest, Sha256};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;
use tokio_rustls::server::TlsStream;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// The digest the signer signs for a certificate: `keccak256("keelson/ra-tls/v1" ‖
/// SHA-256(certificate DER))`.
pub fn binding_digest(certificate_sha256: &[u8; 32]) -> [u8; 32] {
    let mut message = b"keelson/ra-tls/v1".to_vec();
    message.extend_from_slice(certificate_sha256);
    keccak256(message).0
}

/// A TLS server configuration from the agent's PEM key and chain, and the SHA-256 of the leaf
/// certificate.
pub fn server_config(
    key_pem: &str,
    chain_pem: &[String],
) -> Result<(ServerConfig, [u8; 32]), String> {
    let chain = chain_pem
        .iter()
        .map(|pem| CertificateDer::from_pem_slice(pem.as_bytes()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("certificate: {e}"))?;
    let leaf = chain.first().ok_or("an empty certificate chain")?;
    let hash: [u8; 32] = Sha256::digest(leaf.as_ref()).into();
    let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes()).map_err(|e| format!("key: {e}"))?;
    let config =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_no_client_auth()
            .with_single_cert(chain, key)
            .map_err(|e| e.to_string())?;
    Ok((config, hash))
}

/// Accepts TLS connections; a connection whose handshake fails or stalls is dropped.
pub struct TlsListener {
    tcp: TcpListener,
    acceptor: TlsAcceptor,
}

impl TlsListener {
    pub fn new(tcp: TcpListener, config: ServerConfig) -> Self {
        Self {
            tcp,
            acceptor: TlsAcceptor::from(Arc::new(config)),
        }
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let Ok((stream, addr)) = self.tcp.accept().await else {
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            };
            if let Ok(Ok(tls)) =
                tokio::time::timeout(HANDSHAKE_TIMEOUT, self.acceptor.accept(stream)).await
            {
                return (tls, addr);
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.tcp.local_addr()
    }
}
