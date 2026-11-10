//! C1 `mandate_predicate` proofs (`circuits/c1`): the countersigned cart satisfies the mandate
//! `C_m` commits to, shown without the mandate.
//!
//! The circuit is executed in process with the ACVM, and the proof is made by a long-lived `bb`
//! child process over its msgpack pipe (`barretenberg-rs`). `bb` reads the CRS from the directory
//! `CRS_PATH` names and downloads what is missing there, so the image ships the points the circuit
//! needs (`zk/bn254_g1.dat`) and proving never reaches the network.

use std::fmt;
use std::io::Read as _;
use std::path::Path;
use std::sync::Mutex;

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

/// A C1 proof as `bb` writes it for the EVM: the proof bytes and its 32-byte public inputs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct C1Proof {
    pub proof: Vec<u8>,
    pub public_inputs: Vec<[u8; 32]>,
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

/// Proves C1 with one `bb` process, one proof at a time.
pub struct Prover {
    bb: Mutex<BarretenbergApi<PipeBackend>>,
    program: Program<FieldElement>,
    /// The ACIR program as `bb` reads it: msgpack, not gzipped.
    bytecode: Vec<u8>,
}

impl Prover {
    /// Starts `bb msgpack run` at `bb`. `CRS_PATH` must name a directory whose `bn254_g1.dat`
    /// holds the first [`CRS_POINTS`] points of the Aztec Ignition CRS (`crs.aztec.network/g1.dat`).
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
        let backend = PipeBackend::new(bb, None).map_err(bb_error)?;
        Ok(Self {
            bb: Mutex::new(BarretenbergApi::new(backend)),
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
        let circuit = CircuitInput {
            name: "mandate_predicate".into(),
            bytecode: self.bytecode.clone(),
            verification_key: VERIFICATION_KEY.to_vec(),
        };
        let out = self
            .bb
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .circuit_prove(circuit, &witness, evm())
            .map_err(bb_error)?;
        Ok(C1Proof {
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
        let out = self
            .bb
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .circuit_verify(
                VERIFICATION_KEY,
                proof.public_inputs.iter().map(|f| f.to_vec()).collect(),
                proof.proof.chunks(32).map(<[u8]>::to_vec).collect(),
                evm(),
            )
            .map_err(bb_error)?;
        Ok(out.verified)
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
