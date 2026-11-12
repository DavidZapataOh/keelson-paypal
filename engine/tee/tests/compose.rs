//! Every compose leg A boots with passes the environment `main.rs` reads before it answers: a
//! missing variable stops the engine at boot, and the CVM never serves `/v1/health`.

const REQUIRED: [&str; 8] = [
    "KEELSON_OCI_DIGEST",
    "KEELSON_CANONICALIZER",
    "KEELSON_ORIGIN",
    "KEELSON_TEE_TOKEN_SHA256",
    "KEELSON_RATLS_LISTEN",
    "KEELSON_RATLS_HOST",
    "PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
];

fn passes(compose: &str, name: &str) -> bool {
    compose
        .lines()
        .any(|l| l.trim_start().starts_with(&format!("- {name}=")))
}

#[test]
fn leg_a_composes_pass_what_the_engine_needs() {
    for (file, compose) in [
        (
            "phala/docker-compose.yml",
            include_str!("../phala/docker-compose.yml"),
        ),
        (
            "phala/rehearsal/docker-compose.yml",
            include_str!("../phala/rehearsal/docker-compose.yml"),
        ),
    ] {
        for name in REQUIRED {
            assert!(passes(compose, name), "{file} does not pass {name}");
        }
    }
}
