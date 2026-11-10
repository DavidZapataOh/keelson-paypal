//! Leg A as a TLSNotary notary. `GET /v1/notary` with `Upgrade: keelson-notary` hands the
//! connection to one TLSNotary session (`keelson_tlsn::notarize`); once the session is accepted,
//! the engine answers on the same connection with the `WebFact` it signed, as one JSON object,
//! and closes it. A refused session is answered with `{ "error": <code> }`.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use hyper_util::rt::TokioIo;
use tokio::io::AsyncWriteExt;

use crate::server::{AppState, Problem};

/// The `Upgrade` protocol token of a notary session.
pub const PROTOCOL: &str = "keelson-notary";

/// Longest a session may take, from the upgrade to the answer.
pub const SESSION_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) async fn notary(State(state): State<Arc<AppState>>, mut request: Request) -> Response {
    let upgrade = request.headers().get(header::UPGRADE);
    if !upgrade.is_some_and(|u| u.as_bytes().eq_ignore_ascii_case(PROTOCOL.as_bytes())) {
        return Problem::new(StatusCode::BAD_REQUEST, "bad_request").into_response();
    }
    let Some(on_upgrade) = request
        .extensions_mut()
        .remove::<hyper::upgrade::OnUpgrade>()
    else {
        return Problem::new(StatusCode::BAD_REQUEST, "bad_request").into_response();
    };
    // One session at a time: MPC-TLS is the heaviest thing the leg does.
    let Ok(permit) = state.notary_slot().clone().try_acquire_owned() else {
        return Problem::new(StatusCode::SERVICE_UNAVAILABLE, "busy").into_response();
    };
    tokio::spawn(async move {
        let _permit = permit;
        let Ok(upgraded) = on_upgrade.await else {
            return;
        };
        let _ =
            tokio::time::timeout(SESSION_TIMEOUT, session(&state, TokioIo::new(upgraded))).await;
    });
    let mut response = StatusCode::SWITCHING_PROTOCOLS.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
    headers.insert(header::UPGRADE, HeaderValue::from_static(PROTOCOL));
    response
}

async fn session<Io>(state: &AppState, io: Io)
where
    Io: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
{
    // A session that fails takes its connection with it; there is nobody left to answer.
    let Ok((notarized, mut io)) = keelson_tlsn::notarize(io).await else {
        return;
    };
    let answer = match notarized {
        Ok(n) => state
            .engine()
            .sign_web_fact(&n.server_name, &n.target, n.commitment, state.now())
            .map_err(|e| e.code()),
        Err(refusal) => Err(refusal.to_string()),
    };
    let bytes = match answer {
        Ok(signed) => serde_json::to_vec(&signed),
        Err(code) => serde_json::to_vec(&serde_json::json!({ "error": code })),
    };
    if let Ok(bytes) = bytes {
        let _ = io.write_all(&bytes).await;
    }
    let _ = io.shutdown().await;
}
