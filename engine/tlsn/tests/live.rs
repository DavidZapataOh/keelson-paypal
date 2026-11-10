//! Full sessions between the prover and the notary against live product endpoints. Run with
//! `cargo test -p keelson-tlsn --release --test live -- --ignored --nocapture`.

use std::time::Instant;

use keelson_tlsn::{Mode, notarize, prove};
use sha2::{Digest, Sha256};

/// The demo store's product API and a public Shopify product endpoint.
const STORE: &str = "https://store.keelson.finance/api/products/tempo-3";
const SHOPIFY: &str = "https://www.deathwishcoffee.com/products/death-wish-coffee.oembed";

/// The time budget of an MPC-TLS session, in milliseconds.
const MPC_BUDGET_MS: u128 = 6_000;

async fn session(url: &str, anchor: Option<&str>, mode: Mode) -> u128 {
    let (prover_io, notary_io) = tokio::io::duplex(1 << 23);
    let started = Instant::now();
    let (notarized, proven) = tokio::try_join!(
        async { notarize(notary_io).await.map(|(n, _)| n.unwrap()) },
        async { prove(prover_io, url, anchor, mode).await.map(|(p, _)| p) },
    )
    .unwrap();
    let ms = started.elapsed().as_millis();

    assert_eq!(notarized.mode, mode);
    assert_eq!(notarized.server_name, proven.server_name);
    assert_eq!(notarized.target, proven.target);
    assert_eq!(notarized.commitment, proven.commitment);
    // tlsn commits as SHA-256(range ‖ blinder).
    let mut h = Sha256::new();
    h.update(&proven.response[proven.range.clone()]);
    h.update(proven.blinder);
    assert_eq!(<[u8; 32]>::from(h.finalize()), proven.commitment);
    println!(
        "{url} {mode:?}: {ms} ms, {} bytes received, range {:?}",
        proven.response.len(),
        proven.range
    );
    ms
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "live: reaches the demo store"]
async fn the_demo_store_product_is_notarized_with_mpc_tls_in_budget() {
    let ms = session(STORE, Some(r#""sku""#), Mode::Mpc).await;
    assert!(ms < MPC_BUDGET_MS, "{ms} ms");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "live: reaches the demo store"]
async fn the_demo_store_product_is_notarized_with_proxy_tls() {
    session(STORE, None, Mode::Proxy).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "live: reaches a Shopify store"]
async fn a_shopify_product_is_notarized_with_mpc_tls() {
    session(SHOPIFY, Some(r#""offer_id":2413985169421"#), Mode::Mpc).await;
}
