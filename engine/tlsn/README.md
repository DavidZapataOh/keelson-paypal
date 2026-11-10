# keelson-tlsn

TLSNotary sessions over public product endpoints, on [`tlsn`](https://github.com/tlsnotary/tlsn) 0.1.0-alpha.15. The library holds both sides: `notarize`, which leg A runs as the notary (see `engine/tee/README.md`), and `prove`, which fetches one `https` JSON endpoint with a single `GET`, reveals the request, the status line and the headers, and commits to the body, or with an anchor to the smallest JSON object in the body that contains it (a variant's `"id":123`, a Shopify offer's `"offer_id":…`), as `SHA-256(range ‖ blinder)`. `policy` is what the notary accepts.

`keelson-prover` (feature `prover`) is the service that runs the prover side against the notary on leg A. It is a Render private service, `keelson-prover`, built from `Dockerfile`:

```sh
curl -X POST http://keelson-prover:10000/v1/prove -H 'content-type: application/json' \
  -d '{"url":"https://store.keelson.finance/api/products/tempo-3","anchor":"\"sku\""}'
```

It answers `{ webFact, mode, ms, range, committed, blinder }`: the `WebFact` leg A signed, the protocol used, the session time, and the committed bytes and blinder that open `rangeCommitment`. It tries MPC-TLS and, when that fails for any reason other than the endpoint or the notary refusing it, Proxy-TLS. The API reaches it as `PROVER_URL` and serves it as `POST /v1/observations/web-fact`, checking that the `WebFact` recovers to leg A's admitted signer and names the URL.

TLSNotary alpha.15 speaks TLS 1.2 with ECDHE and AES-128-GCM only, and the response must fit in 16 KiB, so a product's JSON endpoint is used, never its HTML page.

## Tests

`cargo test -p keelson-tlsn` checks the policy. `cargo test -p keelson-tlsn --release --test live -- --ignored --nocapture` runs whole sessions, prover and notary on one host, against the demo store (MPC-TLS within 6 s, and Proxy-TLS) and a Shopify product's `.oembed`; `cargo test -p keelson-tee --features tdx --test notary -- --include-ignored` runs one through leg A's HTTP route. CI runs both on `main`.
