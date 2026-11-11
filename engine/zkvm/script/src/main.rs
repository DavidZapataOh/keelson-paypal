//! Executes or proves the engine's SP1 program over a stored countersign input.
//!
//! ```text
//! keelson-engine-proof vkey
//! keelson-engine-proof execute <input.json>
//! keelson-engine-proof prove <input.json> <proof.json>
//! keelson-engine-proof request <input.json>
//! keelson-engine-proof wait <input.json> <request-id> <proof.json>
//! ```
//!
//! The input is a `CountersignInput` as JSON. Every command first recomputes the countersign
//! natively and refuses to go on unless the zkVM commits the same `evalHash` and digest.
//!
//! `prove` proves on this machine. `request` and `wait` prove on the Succinct Prover Network on
//! mainnet with `NETWORK_PRIVATE_KEY`, in two steps so that a paid request is never lost: `request`
//! prints the request's id as soon as the network takes it, and `wait` waits for that request,
//! which a caller that died in between can do again without paying for another. `request` needs
//! `ENGINE_PROOF_MAX_COST`, the most PROVE (in wei) the request may cost: it is refused unless the
//! Groth16 base fee plus the simulated gas at the price bid fits under it, and cancelled unless the
//! base fee the request was signed with does.

use std::io::Write;
use std::time::{Duration, Instant};

use alloy_primitives::{U256, hex};
use keelson_policy::{CountersignInput, recompute};
use serde::Serialize;
use sp1_sdk::blocking::{NetworkProver, ProveRequest, Prover, ProverClient};
use sp1_sdk::network::proto::GetProofRequestParamsResponse;
use sp1_sdk::network::{
    B256, DEFAULT_MAX_PRICE_PER_PGU_BUFFER, NetworkMode, get_explorer_url_for_mode,
};
use sp1_sdk::{
    Elf, HashableKey, ProvingKey, SP1ProofMode, SP1ProofWithPublicValues, SP1Stdin, include_elf,
};

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
    #[serde(skip_serializing_if = "Option::is_none")]
    network: Option<NetworkRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    peak_rss_kb: Option<u64>,
}

/// A request the Succinct Prover Network took. Amounts are PROVE wei.
#[derive(Serialize)]
struct Requested {
    request_id: String,
    explorer: String,
    cycle_limit: u64,
    gas_limit: u64,
    max_cost: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    peak_rss_kb: Option<u64>,
}

/// A proof request fulfilled by the Succinct Prover Network. Amounts are PROVE wei.
#[derive(Serialize)]
struct NetworkRequest {
    request_id: String,
    explorer: String,
    gas_limit: Option<u64>,
    gas_used: Option<u64>,
    cost: Option<String>,
    balance: Option<String>,
}

/// How long provers have to bid before the request is cancelled.
const AUCTION_TIMEOUT: Duration = Duration::from_secs(120);
/// Seconds the auction stays open before it settles, so that more than one prover can bid.
const MIN_AUCTION_PERIOD: u64 = 10;
/// How long the winning prover has to fulfil the request; an unfulfilled request is not refunded.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(30 * 60);

fn main() {
    sp1_sdk::utils::setup_logger();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["vkey"] => {
            let client = ProverClient::from_env();
            let pk = client.setup(ELF).expect("the program sets up");
            println!("{}", pk.verifying_key().bytes32());
        }
        ["execute", input] => {
            let client = ProverClient::from_env();
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
            assert!(
                std::env::var("SP1_PROVER").as_deref() != Ok("network"),
                "the network proves with `request` and `wait`"
            );
            let (stdin, expected) = load(input);
            write(out, &prove_locally(stdin, &expected));
        }
        ["request", input] => {
            let (stdin, _) = load(input);
            request(stdin);
        }
        ["wait", input, request_id, out] => {
            let (_, expected) = load(input);
            let request_id: B256 = request_id.parse().expect("a request id");
            write(out, &wait(request_id, &expected));
        }
        _ => {
            eprintln!(
                "usage: keelson-engine-proof vkey | execute <input> | prove <input> <out> \
                 | request <input> | wait <input> <request-id> <out>"
            );
            std::process::exit(2);
        }
    }
}

/// Proves on this machine with the prover `SP1_PROVER` selects.
fn prove_locally(stdin: SP1Stdin, expected: &[u8; 64]) -> Proved {
    let client = ProverClient::from_env();
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
    proved(
        &proof,
        pk.verifying_key().bytes32(),
        expected,
        report.total_instruction_count(),
        prove_ms,
        None,
    )
}

fn network() -> NetworkProver {
    ProverClient::builder()
        .network_for(NetworkMode::Mainnet)
        .build()
}

fn explorer(request_id: B256) -> String {
    format!(
        "{}/request/{request_id}",
        get_explorer_url_for_mode(NetworkMode::Mainnet)
    )
}

/// Requests a Groth16 proof from the Succinct Prover Network's mainnet auction, within
/// `ENGINE_PROOF_MAX_COST`, and prints the request before anything else can fail.
fn request(stdin: SP1Stdin) {
    let max_cost: U256 = std::env::var("ENGINE_PROOF_MAX_COST")
        .expect("ENGINE_PROOF_MAX_COST is set")
        .parse()
        .expect("ENGINE_PROOF_MAX_COST is a PROVE amount in wei");
    let client = network();

    // The simulation gives the request its cycle and gas limits: the network never charges more
    // gas than the limit, so the base fee plus the limit at the bid price bounds the cost.
    let (_, report) = client
        .execute(ELF, stdin.clone())
        .calculate_gas(true)
        .run()
        .expect("the program runs");
    let cycle_limit = report.total_instruction_count();
    let gas_limit = report.gas().expect("the simulation measures gas");
    let (base_fee, max_price_per_pgu) = auction_price(&client);
    let worst = U256::from(base_fee) + U256::from(gas_limit) * U256::from(max_price_per_pgu);
    assert!(
        worst <= max_cost,
        "the proof may cost up to {worst} PROVE wei, over ENGINE_PROOF_MAX_COST {max_cost}"
    );

    let pk = client.setup(ELF).expect("the program sets up");
    let request_id = client
        .prove(&pk, stdin)
        .groth16()
        .cycle_limit(cycle_limit)
        .gas_limit(gas_limit)
        .max_price_per_pgu(max_price_per_pgu)
        .min_auction_period(MIN_AUCTION_PERIOD)
        .timeout(NETWORK_TIMEOUT)
        .request()
        .expect("the network takes the request");
    print(&Requested {
        request_id: request_id.to_string(),
        explorer: explorer(request_id),
        cycle_limit,
        gas_limit,
        max_cost: worst.to_string(),
        peak_rss_kb: peak_rss_kb(),
    });
    std::io::stdout().flush().expect("the request is printed");

    // The SDK reads the auction parameters again to sign the request: a base fee that rose in
    // between, or one the network does not report, cancels the request while it is in its auction.
    let signed_fee = client
        .get_proof_request(request_id)
        .ok()
        .flatten()
        .and_then(|r| r.base_fee)
        .and_then(|f| f.parse::<U256>().ok());
    let refused = match signed_fee {
        None => Some(format!("request {request_id} reports no base fee")),
        Some(fee) => {
            let worst = fee + U256::from(gas_limit) * U256::from(max_price_per_pgu);
            (worst > max_cost).then(|| {
                format!(
                    "the base fee rose to {fee} PROVE wei, over ENGINE_PROOF_MAX_COST {max_cost}"
                )
            })
        }
    };
    if let Some(reason) = refused {
        client
            .cancel_request(request_id)
            .expect("the request cancels");
        panic!("{reason}: request {request_id} is cancelled");
    }
}

/// Waits for the network to fulfil request `request_id`, verifies its proof here and adds the
/// request's accounting, which is best effort and never loses the paid proof.
fn wait(request_id: B256, expected: &[u8; 64]) -> Proved {
    let client = network();
    let pk = client.setup(ELF).expect("the program sets up");
    let started = Instant::now();
    let proof = client
        .wait_proof(request_id, Some(NETWORK_TIMEOUT), Some(AUCTION_TIMEOUT))
        .expect("the network fulfils the request");
    let prove_ms = started.elapsed().as_millis();
    client
        .verify(&proof, pk.verifying_key(), None)
        .expect("the proof verifies");

    let request = client.get_proof_request(request_id).ok().flatten();
    let amount = |a: Option<&String>| a.and_then(|a| a.parse::<U256>().ok());
    let cost = request.as_ref().and_then(|r| {
        let deducted = amount(r.deduction_amount.as_ref())?;
        let refunded = amount(r.refund_amount.as_ref()).unwrap_or(U256::ZERO);
        deducted.checked_sub(refunded).map(|c| c.to_string())
    });
    let network = NetworkRequest {
        request_id: request_id.to_string(),
        explorer: explorer(request_id),
        gas_limit: request.as_ref().map(|r| r.gas_limit),
        gas_used: request.as_ref().and_then(|r| r.gas_used),
        cost,
        balance: client.get_balance().ok().map(|b| b.to_string()),
    };
    let cycles = request.as_ref().and_then(|r| r.cycles).unwrap_or_default();
    proved(
        &proof,
        pk.verifying_key().bytes32(),
        expected,
        cycles,
        prove_ms,
        Some(network),
    )
}

/// The Groth16 base fee and the price per PGU to bid: the network's suggested maximum with the
/// SDK's default 20% headroom, on the auction's tick.
fn auction_price(client: &NetworkProver) -> (u64, u64) {
    let GetProofRequestParamsResponse::Auction(params) = client
        .get_proof_request_params(SP1ProofMode::Groth16)
        .expect("the auction parameters read")
    else {
        panic!("the mainnet network runs an auction");
    };
    let base_fee: u64 = params.base_fee.parse().expect("a base fee");
    let suggested: u64 = params.max_price_per_pgu.parse().expect("a price per PGU");
    let price = u128::from(suggested) * u128::from(DEFAULT_MAX_PRICE_PER_PGU_BUFFER) / 100;
    let price = u64::try_from(price).expect("a price per PGU");
    let price = if params.tick_size > 1 {
        price - price % params.tick_size
    } else {
        price
    };
    (base_fee, price)
}

fn proved(
    proof: &SP1ProofWithPublicValues,
    vkey: String,
    expected: &[u8; 64],
    cycles: u64,
    prove_ms: u128,
    network: Option<NetworkRequest>,
) -> Proved {
    check(proof.public_values.as_slice(), expected);
    let bytes = proof.bytes();
    Proved {
        vkey,
        public_values: hex::encode_prefixed(proof.public_values.as_slice()),
        proof: hex::encode_prefixed(&bytes),
        eval_hash: hex::encode_prefixed(&expected[..32]),
        countersign_digest: hex::encode_prefixed(&expected[32..]),
        cycles,
        prove_ms,
        proof_bytes: bytes.len(),
        sp1_version: sp1_sdk::SP1_CIRCUIT_VERSION,
        network,
        peak_rss_kb: peak_rss_kb(),
    }
}

/// This process's peak resident memory, where Linux reports it.
fn peak_rss_kb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
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

fn write(path: &str, proved: &Proved) {
    std::fs::write(path, serde_json::to_vec_pretty(proved).expect("JSON"))
        .expect("the proof is written");
    print(proved);
}

fn print(v: &impl Serialize) {
    println!("{}", serde_json::to_string(v).expect("JSON"));
}
