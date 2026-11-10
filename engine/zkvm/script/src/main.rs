//! Executes or proves the engine's SP1 program over a stored countersign input.
//!
//! ```text
//! keelson-engine-proof vkey
//! keelson-engine-proof execute <input.json>
//! keelson-engine-proof prove <input.json> <proof.json>
//! ```
//!
//! The input is a `CountersignInput` as JSON. Both commands first recompute the countersign
//! natively and refuse to go on unless the zkVM commits the same `evalHash` and digest. `SP1_PROVER`
//! selects the prover (`cpu` by default, `network` with `NETWORK_PRIVATE_KEY`).

use std::time::Instant;

use alloy_primitives::hex;
use keelson_policy::{CountersignInput, recompute};
use serde::Serialize;
use sp1_sdk::blocking::{ProveRequest, Prover, ProverClient};
use sp1_sdk::{Elf, HashableKey, ProvingKey, SP1Stdin, include_elf};

const ELF: Elf = include_elf!("keelson-engine-program");

#[derive(Serialize)]
struct Executed {
    eval_hash: String,
    countersign_digest: String,
    cycles: u64,
    execute_ms: u128,
}

#[derive(Serialize)]
struct Proved {
    vkey: String,
    public_values: String,
    proof: String,
    eval_hash: String,
    countersign_digest: String,
    cycles: u64,
    prove_ms: u128,
    proof_bytes: usize,
    sp1_version: &'static str,
}

fn main() {
    sp1_sdk::utils::setup_logger();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let client = ProverClient::from_env();
    match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["vkey"] => {
            let pk = client.setup(ELF).expect("the program sets up");
            println!("{}", pk.verifying_key().bytes32());
        }
        ["execute", input] => {
            let (stdin, expected) = load(input);
            let started = Instant::now();
            let (public_values, report) =
                client.execute(ELF, stdin).run().expect("the program runs");
            let execute_ms = started.elapsed().as_millis();
            check(public_values.as_slice(), &expected);
            print(&Executed {
                eval_hash: hex::encode_prefixed(&expected[..32]),
                countersign_digest: hex::encode_prefixed(&expected[32..]),
                cycles: report.total_instruction_count(),
                execute_ms,
            });
        }
        ["prove", input, out] => {
            let (stdin, expected) = load(input);
            let (_, report) = client
                .execute(ELF, stdin.clone())
                .run()
                .expect("the program runs");
            let pk = client.setup(ELF).expect("the program sets up");
            let started = Instant::now();
            let proof = client
                .prove(&pk, stdin)
                .groth16()
                .run()
                .expect("the program proves");
            let prove_ms = started.elapsed().as_millis();
            client
                .verify(&proof, pk.verifying_key(), None)
                .expect("the proof verifies");
            check(proof.public_values.as_slice(), &expected);
            let bytes = proof.bytes();
            let proved = Proved {
                vkey: pk.verifying_key().bytes32(),
                public_values: hex::encode_prefixed(proof.public_values.as_slice()),
                proof: hex::encode_prefixed(&bytes),
                eval_hash: hex::encode_prefixed(&expected[..32]),
                countersign_digest: hex::encode_prefixed(&expected[32..]),
                cycles: report.total_instruction_count(),
                prove_ms,
                proof_bytes: bytes.len(),
                sp1_version: sp1_sdk::SP1_CIRCUIT_VERSION,
            };
            std::fs::write(out, serde_json::to_vec_pretty(&proved).expect("JSON"))
                .expect("the proof is written");
            print(&proved);
        }
        _ => {
            eprintln!("usage: keelson-engine-proof vkey | execute <input> | prove <input> <out>");
            std::process::exit(2);
        }
    }
}

/// The program's stdin and the public values the native recomputation expects.
fn load(path: &str) -> (SP1Stdin, [u8; 64]) {
    let json = std::fs::read(path).expect("the input is readable");
    let input: CountersignInput = serde_json::from_slice(&json).expect("a countersign input");
    let c = recompute(&input).expect("the countersign recomputes natively");
    let mut expected = [0; 64];
    expected[..32].copy_from_slice(c.countersign.evalHash.as_slice());
    expected[32..].copy_from_slice(&c.digest);
    let mut stdin = SP1Stdin::new();
    stdin.write_vec(json);
    (stdin, expected)
}

fn check(public_values: &[u8], expected: &[u8; 64]) {
    assert_eq!(
        public_values, expected,
        "the zkVM committed another evalHash or digest than the native engine"
    );
}

fn print(v: &impl Serialize) {
    println!("{}", serde_json::to_string(v).expect("JSON"));
}
