//! C1 `mandate_predicate` proofs (`circuits/c1`): the countersigned cart satisfies the mandate
//! `C_m` commits to, shown without the mandate. Each proof is made twice from one witness: for the
//! EVM (keccak transcript), which contracts and bb.js check, and for recursion (Poseidon2
//! transcript), which a Noir circuit verifies to compose C1 with C3.
//!
//! The circuit is executed in process with the ACVM, and the two proofs are made at the same time
//! by two long-lived `bb` child processes over their msgpack pipes (`barretenberg-rs`). `bb` reads
//! the CRS from the directory `CRS_PATH` names and downloads what is missing there, so the image
//! ships the points the circuit needs (`zk/bn254_g1.dat`) and proving never reaches the network.

use std::fmt;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, mpsc};
use std::time::Duration;

use acir::FieldElement;
use acir::circuit::Program;
use acir::native_types::{Witness, WitnessMap, WitnessStack};
use acvm::pwg::{ACVM, ACVMStatus};
use barretenberg_rs::BarretenbergApi;
use barretenberg_rs::backends::PipeBackend;
use barretenberg_rs::generated_types::{CircuitInput, ProofSystemSettings};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use bn254_blackbox_solver::Bn254BlackBoxSolver;
use flate2::read::GzDecoder;
use keelson_mandate::{MandateOpening, MembershipProof};
use serde::Deserialize;

/// The compiled circuit: `{ noir_version, hash, abi, bytecode }` of the nargo artifact.
const ARTIFACT: &str = include_str!("../zk/mandate_predicate.json");
/// The circuit's UltraHonk verification key for the EVM target (keccak transcript, ZK).
pub const VERIFICATION_KEY: &[u8] = include_bytes!("../zk/mandate_predicate.vk");
/// The circuit's UltraHonk verification key for recursion (Poseidon2 transcript, ZK).
pub const RECURSIVE_VERIFICATION_KEY: &[u8] =
    include_bytes!("../zk/mandate_predicate.recursive.vk");
/// The CRS points the circuit needs: one more than its 2^13 rows, 64 bytes each.
const CRS_POINTS: u64 = (1 << 13) + 1;

/// The public inputs of C1, in the circuit's order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Statement {
    /// `C_m`, the countersign's `mandateCommitment`.
    pub c_m: FieldElement,
    /// The cart total in minor units.
    pub amount: u64,
    /// The ISO 4217 numeric code.
    pub currency: u16,
    /// The cart's category bit.
    pub category: u8,
    /// The countersign's `merchantId`.
    pub merchant_id: FieldElement,
    /// The countersign's `issuedAt`.
    pub now: u64,
    /// The countersign's `cartHash` reduced modulo the field.
    pub cart_hash: FieldElement,
    /// The mandate's `agent.operator.agent_id`.
    pub operator_id: FieldElement,
}

/// A C1 proof as `bb` writes it for the EVM: the proof bytes and its 32-byte public inputs, with
/// the proof of the same witness for recursion.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct C1Proof {
    pub proof: Vec<u8>,
    pub public_inputs: Vec<[u8; 32]>,
    /// The proof's fields for `bb prove -t noir-recursive`, 32 bytes each; none when only that
    /// proof failed, so the EVM proof is still served.
    pub recursive_proof: Option<Vec<u8>>,
}

#[derive(Debug)]
pub enum ProverError {
    /// The witness does not satisfy the circuit.
    Unsatisfied(String),
    /// `bb` failed or could not be reached.
    Backend(String),
}

impl fmt::Display for ProverError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsatisfied(e) => write!(f, "the C1 witness does not satisfy the circuit: {e}"),
            Self::Backend(e) => write!(f, "bb: {e}"),
        }
    }
}

impl std::error::Error for ProverError {}

#[derive(Deserialize)]
struct Artifact {
    bytecode: String,
}

/// UltraHonk with the keccak transcript and ZK: what `bb prove -t evm` makes and the Solidity
/// verifier and bb.js `verifierTarget: "evm"` check.
fn evm() -> ProofSystemSettings {
    ProofSystemSettings {
        ipa_accumulation: false,
        oracle_hash_type: "keccak".into(),
        disable_zk: false,
        optimized_solidity_verifier: false,
    }
}

/// UltraHonk with the Poseidon2 transcript and ZK: what `bb prove -t noir-recursive` makes and
/// `std::verify_proof_with_type` checks in a circuit.
fn noir_recursive() -> ProofSystemSettings {
    ProofSystemSettings {
        ipa_accumulation: false,
        oracle_hash_type: "poseidon2".into(),
        disable_zk: false,
        optimized_solidity_verifier: false,
    }
}

/// How long one `bb` call may take before its process is abandoned and a new one started.
const BB_DEADLINE: Duration = Duration::from_secs(5);

type Api = BarretenbergApi<PipeBackend>;
type Job = Box<dyn FnOnce(&mut Api) + Send>;

/// The threads each of the two `bb` processes proves with: half the cores. On a 4-vCPU runner two
/// processes of 2 threads prove a statement in 285 ms (p50), two of 4 in 364 ms.
fn threads() -> usize {
    std::thread::available_parallelism().map_or(1, |n| (n.get() / 2).max(1))
}

/// Starts `bb msgpack run` on a thread of its own that runs each job it is sent in turn. Dropping
/// the sender ends the thread, and dropping the backend kills `bb`.
fn start(bb: &Path) -> Result<mpsc::Sender<Job>, ProverError> {
    let mut api = BarretenbergApi::new(PipeBackend::new(bb, Some(threads())).map_err(bb_error)?);
    let (tx, rx) = mpsc::channel::<Job>();
    std::thread::spawn(move || {
        for job in rx {
            job(&mut api);
        }
    });
    Ok(tx)
}

/// Proves C1 with two `bb` processes, one per transcript, so a statement's two proofs are made at
/// the same time. A call that fails or outlives [`BB_DEADLINE`] abandons its process; the next call
/// on that transcript starts a new one.
pub struct Prover {
    bb: PathBuf,
    evm: Mutex<Option<mpsc::Sender<Job>>>,
    recursive: Mutex<Option<mpsc::Sender<Job>>>,
    program: Program<FieldElement>,
    /// The ACIR program as `bb` reads it: msgpack, not gzipped.
    bytecode: Vec<u8>,
}

impl Prover {
    /// Starts two `bb msgpack run` processes of `bb`. `CRS_PATH` must name a directory whose
    /// `bn254_g1.dat` holds the first [`CRS_POINTS`] points of the Aztec Ignition CRS
    /// (`crs.aztec.network/g1.dat`).
    pub fn spawn(bb: &Path) -> Result<Self, ProverError> {
        let crs = std::env::var_os("CRS_PATH")
            .map(|dir| Path::new(&dir).join("bn254_g1.dat"))
            .ok_or_else(|| ProverError::Backend("CRS_PATH is not set".into()))?;
        match std::fs::metadata(&crs) {
            Ok(m) if m.len() >= CRS_POINTS * 64 => {}
            _ => {
                return Err(ProverError::Backend(format!(
                    "{} does not hold {CRS_POINTS} points",
                    crs.display()
                )));
            }
        }
        let artifact: Artifact = serde_json::from_str(ARTIFACT).expect("the embedded artifact");
        let gzipped = STANDARD
            .decode(artifact.bytecode)
            .expect("the embedded bytecode is base64");
        let program = Program::deserialize_program(&gzipped).expect("the embedded program");
        let mut bytecode = Vec::new();
        GzDecoder::new(gzipped.as_slice())
            .read_to_end(&mut bytecode)
            .expect("the embedded bytecode is gzipped");
        Ok(Self {
            evm: Mutex::new(Some(start(bb)?)),
            recursive: Mutex::new(Some(start(bb)?)),
            bb: bb.to_owned(),
            program,
            bytecode,
        })
    }

    /// Proves `statement` from the mandate's opening and the merchant's leaf opening.
    pub fn prove(
        &self,
        statement: &Statement,
        opening: &MandateOpening,
        merchant: &MembershipProof,
    ) -> Result<C1Proof, ProverError> {
        let witness = self.solve(witness_inputs(statement, opening, merchant))?;
        let stack = WitnessStack::from(witness)
            .serialize()
            .map_err(|e| ProverError::Backend(e.to_string()))?;
        let mut witness = Vec::new();
        GzDecoder::new(stack.as_slice())
            .read_to_end(&mut witness)
            .map_err(|e| ProverError::Backend(e.to_string()))?;
        let circuit = |vk: &[u8]| CircuitInput {
            name: "mandate_predicate".into(),
            bytecode: self.bytecode.clone(),
            verification_key: vk.to_vec(),
        };
        let (evm_circuit, recursive_circuit) = (
            circuit(VERIFICATION_KEY),
            circuit(RECURSIVE_VERIFICATION_KEY),
        );
        let recursive_witness = witness.clone();
        let (out, recursive) = std::thread::scope(|scope| {
            let recursive = scope.spawn(|| {
                self.call(&self.recursive, move |api| {
                    api.circuit_prove(recursive_circuit, &recursive_witness, noir_recursive())
                })
            });
            let out = self.call(&self.evm, move |api| {
                api.circuit_prove(evm_circuit, &witness, evm())
            });
            (out, recursive.join().expect("the recursive proof's thread"))
        });
        let out = out?;
        let recursive = recursive
            .map_err(|e| eprintln!("keelson-engine: no recursive C1 proof: {e}"))
            .ok();
        Ok(C1Proof {
            recursive_proof: recursive.map(|r| r.proof.concat()),
            proof: out.proof.concat(),
            public_inputs: out
                .public_inputs
                .iter()
                .map(|f| f.as_slice().try_into())
                .collect::<Result<_, _>>()
                .map_err(|_| ProverError::Backend("a public input is not 32 bytes".into()))?,
        })
    }

    /// Verifies `proof` against the embedded verification key with the same `bb`.
    pub fn verify(&self, proof: &C1Proof) -> Result<bool, ProverError> {
        let inputs = proof.public_inputs.iter().map(|f| f.to_vec()).collect();
        let fields = proof.proof.chunks(32).map(<[u8]>::to_vec).collect();
        let out = self.call(&self.evm, move |api| {
            api.circuit_verify(VERIFICATION_KEY, inputs, fields, evm())
        })?;
        Ok(out.verified)
    }

    /// Verifies `proof`'s recursive proof against the embedded recursive key with the same `bb`.
    pub fn verify_recursive(&self, proof: &C1Proof) -> Result<bool, ProverError> {
        let inputs = proof.public_inputs.iter().map(|f| f.to_vec()).collect();
        let Some(recursive) = &proof.recursive_proof else {
            return Ok(false);
        };
        let fields = recursive.chunks(32).map(<[u8]>::to_vec).collect();
        let out = self.call(&self.recursive, move |api| {
            api.circuit_verify(RECURSIVE_VERIFICATION_KEY, inputs, fields, noir_recursive())
        })?;
        Ok(out.verified)
    }

    /// Runs `f` on `worker`, starting one when there is none, within [`BB_DEADLINE`].
    fn call<T: Send + 'static>(
        &self,
        worker: &Mutex<Option<mpsc::Sender<Job>>>,
        f: impl FnOnce(&mut Api) -> barretenberg_rs::Result<T> + Send + 'static,
    ) -> Result<T, ProverError> {
        let mut worker = worker.lock().unwrap_or_else(|e| e.into_inner());
        let tx = match worker.as_ref() {
            Some(tx) => tx.clone(),
            None => worker.insert(start(&self.bb)?).clone(),
        };
        let (done, answer) = mpsc::sync_channel(1);
        let sent = tx.send(Box::new(move |api: &mut Api| {
            let _ = done.send(f(api));
        }));
        let out = match sent.map(|()| answer.recv_timeout(BB_DEADLINE)) {
            Ok(Ok(Ok(out))) => return Ok(out),
            Ok(Ok(Err(e))) => bb_error(e),
            Ok(Err(_)) => ProverError::Backend(format!("no answer within {BB_DEADLINE:?}")),
            Err(_) => ProverError::Backend("the bb worker is gone".into()),
        };
        *worker = None;
        Err(out)
    }

    fn solve(&self, inputs: Vec<FieldElement>) -> Result<WitnessMap<FieldElement>, ProverError> {
        let main = &self.program.functions[0];
        let initial = (0u32..)
            .zip(inputs)
            .map(|(i, v)| (Witness(i), v))
            .collect::<std::collections::BTreeMap<_, _>>()
            .into();
        let solver = Bn254BlackBoxSolver;
        let mut acvm = ACVM::new(
            &solver,
            &main.opcodes,
            initial,
            &self.program.unconstrained_functions,
            &main.assert_messages,
        );
        match acvm.solve() {
            ACVMStatus::Solved => Ok(acvm.finalize()),
            status => Err(ProverError::Unsatisfied(status.to_string())),
        }
    }
}

fn bb_error(e: barretenberg_rs::BarretenbergError) -> ProverError {
    ProverError::Backend(e.to_string())
}

/// The circuit's parameters flattened in ABI order, each its own witness from `w0`.
fn witness_inputs(
    s: &Statement,
    o: &MandateOpening,
    merchant: &MembershipProof,
) -> Vec<FieldElement> {
    let int = |v: u64| FieldElement::from(u128::from(v));
    let mut inputs = vec![
        s.c_m,
        int(s.amount),
        int(u64::from(s.currency)),
        int(u64::from(s.category)),
        s.merchant_id,
        int(s.now),
        s.cart_hash,
        s.operator_id,
        o.user_key_hash,
        int(o.max_amount),
        int(o.category_mask),
        o.merchants.root(),
        int(o.expiry),
        o.nonce,
        o.salt,
        merchant.leaf.next,
        int(merchant.leaf.next_index as u64),
        int(merchant.index as u64),
    ];
    inputs.extend(&merchant.path);
    inputs
}
