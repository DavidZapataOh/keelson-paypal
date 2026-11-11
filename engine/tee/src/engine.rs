//! The engine: registers mandates and countersigns carts.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt;
use std::sync::{Arc, Condvar, Mutex};

use alloy_primitives::aliases::U40;
use alloy_primitives::{Address, B256, U256};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use keelson_canon::{canonicalize, cart_hash};
use keelson_core::eip712::{CardAuthorization, Countersign, WebFact};
use keelson_core::{AcirField, currency_numeric};
use keelson_mandate::{
    ClosedMandateVerifyOptions, EMBED_ORIGIN, Expected, Fr, Jwk, OpenMandateParams,
    OpenMandateVerifyOptions, PasskeyCredential, RP_ID, USER_CREDENTIAL_TYP, UserAuth,
    UserCredentialParams, WebAuthnError, decode_mandate, h_sd, issue_open_mandate,
    issue_user_credential, mandate_challenge, mandate_commitment, mandate_opening, merchant_leaf,
    merchant_membership, spc_details, verify_assertion, verify_closed_mandate, verify_credential,
};
use keelson_policy::{
    Decision, EngineMeta, EvalInput, VerdictError, VerdictInput, agent_uid, cart_trace, category,
    deny_trace, eval_hash, policy_set_hash, trace_jcs,
};
use p256::ecdsa::SigningKey;
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};
use ulid::Ulid;

use crate::budget::{Budget, Claimed, Replay};
use crate::cards::{Approval, CardLedger, DurableCards, card_bit};
use crate::checkpoint::{CheckpointError, verify_checkpoint};
use crate::logsign::{LogSigner, SignError, SignRequest, Signed};
use crate::paypal::{HoldKind, PayPalDeny, paypal_check};
use crate::wire::{
    self, Base64, CardAuthorizeRequest, CardAuthorized, CheckpointRequest, CheckpointSigned,
    CountersignJson, CountersignRequest, Countersigned, Hex, MandateIssued, Observation,
    PayPalObservation, RegisterMandate, VerdictRequest, VerdictSigned, WebFactJson, WebFactSigned,
    ZkProof,
};
use crate::zk::{Prover, Statement};
use crate::{
    Error, Root, SealAad, Signer, SignerBinding, TeeKind, countersign_digest, failed_fields_mask,
};

/// The seal purpose of a mandate's commitment salt; the record is `M`.
pub const MANDATE_SALT_PURPOSE: &str = "keelson/seal/mandate-salt/v1";
/// The sealing purpose of the record that binds a mandate to the PayPal order holding its funds.
const MANDATE_HOLD_PURPOSE: &str = "keelson/seal/mandate-hold-order/v1";
const ARBITRUM_ONE: u64 = 42_161;

/// `iss` of the user credential.
const ISSUER: &str = "https://keelson.finance";
/// `aud` of the open mandate; its `nonce` is the mandate `mid`.
const OPEN_MANDATE_AUD: &str = "keelson.finance";
/// Lifetime of a countersign, and how long after boot nothing is allowed.
const COUNTERSIGN_TTL: i64 = 900;
/// Clock skew tolerated on credential and key-binding times.
const MAX_SKEW_SEC: i64 = 60;
/// How far ahead of this leg's clock leg A's observation may be. It may be older by up to
/// `MAX_SKEW_SEC`: leg A answers a retry with the observation it recorded on the first try.
const MAX_OBSERVATION_AHEAD_MS: i64 = 2_000;

/// Longest `sub`, in bytes; the mandate schema's limit for `user.sub`.
const MAX_SUB: usize = 128;
/// Longest free-form string of a cart, a purchase unit or an evidence source, in bytes.
const MAX_STRING: usize = 256;
/// Longest credential or presentation, in bytes.
const MAX_TOKEN: usize = 128 * 1024;
/// Longest serialized `payload_sd`, in bytes.
const MAX_PAYLOAD: usize = 128 * 1024;
/// Most disclosures a mandate comes with.
const MAX_DISCLOSURES: usize = 512;
/// Longest disclosure or assertion part, in bytes: the mandate schema's longest string, base64url
/// encoded in a disclosure with its salt and name.
const MAX_PART: usize = 4096;
/// Most cart lines the engine reads; the canonicalizer denies more than it supports.
const MAX_CART_LINES: usize = 64;
/// Most fields with evidence.
const MAX_EVIDENCE_FIELDS: usize = 16;
/// Most evidence sources of one field.
const MAX_SOURCES: usize = 16;

/// Boot configuration, bound into the attestation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineConfig {
    /// The chain the engine attests to and countersigns for unless a request names another of
    /// the chains `keelson_core::domain` accepts. The same signer serves every one of them: each
    /// chain's EIP-712 domain and attestation binding carry its chain id, so nothing signed or
    /// attested for one chain verifies on another.
    pub chain_id: u64,
    pub bond_vault: Address,
    pub verifying_contract: Address,
    /// The OCI image digest of the engine.
    pub oci_digest: String,
    pub canonicalizer: String,
    pub tee_kind: TeeKind,
    /// The user credential issuer's public key, for an engine without a root. An engine with a
    /// root derives it and ignores this.
    pub issuer: Option<Jwk>,
    /// The origin passkey assertions are made on.
    pub origin: String,
}

/// The amount captured against each mandate, as the engine's own PayPal read reports it.
pub trait CapturedSource: Send + Sync {
    /// Minor units authorized or captured, and not voided or refunded, against the mandate whose
    /// challenge is `mandate_hash`, read fresh; or `None` while it has not been read, which
    /// refuses the countersign. A reservation lasts only as long as its countersign, so anything
    /// spent under it must show here by then.
    fn captured_minor(&self, mandate_hash: &[u8; 32]) -> Option<i64>;
}

/// Where the engine keeps each user's sealed record. The engine seals what it stores, so the
/// store only keeps opaque blobs; a store that loses a record lets that user be bound again.
pub trait UserRecords: Send + Sync {
    fn get(&self, sub: &str) -> Option<Vec<u8>>;
    /// Stores `record` for `sub` unless one is already there, and says whether it did.
    fn insert_new(&self, sub: &str, record: Vec<u8>) -> bool;
}

/// Why a request was refused, with no signature.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EngineError {
    /// The mandate failed authentication: a `closed_*`, `open_*` or `webauthn_*` code.
    Auth(String),
    /// The observed clock is more than 2,000 ms from this engine's.
    Clock,
    /// The request needs the KMS root, which this engine does not have.
    NoRoot,
    /// The salt does not open the mandate's `zk.commitment`.
    CommitmentMismatch,
    BadRequest(&'static str),
    /// An input is longer or more numerous than the engine reads.
    TooLarge(&'static str),
    /// The mandate's `exp` has passed.
    Expired,
    /// The mandate's `nbf` has not been reached.
    NotYetValid,
    /// A leg A input is missing: the captured amount or the user records.
    NotReady,
    /// The request id was already countersigned for another cart.
    Replay,
    /// The engine already holds as many live requests as it keeps.
    Busy,
    /// PayPal could not be read, so nothing can be countersigned.
    PayPal,
    /// The signer could not sign; see [`Error`].
    Signer(Error),
    /// The checkpoint is not one the engine signs.
    Checkpoint(CheckpointError),
    /// The log checkpoint was not signed.
    Log(SignError),
}

impl EngineError {
    /// The stable error code.
    pub fn code(&self) -> String {
        match self {
            Self::Auth(code) => format!("auth.{code}"),
            Self::Clock => "clock_skew".into(),
            Self::NoRoot => "no_root".into(),
            Self::CommitmentMismatch => "commitment_mismatch".into(),
            Self::BadRequest(_) => "bad_request".into(),
            Self::TooLarge(_) => "payload_too_large".into(),
            Self::Expired => "mandate_expired".into(),
            Self::NotYetValid => "mandate_not_yet_valid".into(),
            Self::NotReady => "not_ready".into(),
            Self::Replay => "replay".into(),
            Self::Busy => "busy".into(),
            Self::PayPal => "paypal".into(),
            Self::Signer(_) => "signer".into(),
            Self::Checkpoint(e) => e.code().into(),
            Self::Log(e) => e.code().into(),
        }
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadRequest(what) => write!(f, "bad_request: {what}"),
            Self::TooLarge(what) => write!(f, "payload_too_large: {what}"),
            Self::Signer(e) => write!(f, "signer: {e}"),
            other => f.write_str(&other.code()),
        }
    }
}

impl std::error::Error for EngineError {}

fn bad(what: &'static str) -> EngineError {
    EngineError::BadRequest(what)
}

fn auth(code: &str) -> EngineError {
    EngineError::Auth(code.into())
}

/// One leg of the engine. With the KMS root (leg A) it issues credentials, keeps the budget
/// ledger and produces the [`Observation`]; without it (leg B) it countersigns over leg A's.
pub struct Engine {
    signer: Signer,
    root: Option<Root>,
    config: EngineConfig,
    boot: OffsetDateTime,
    budget: Budget,
    cards: CardLedger,
    issuer: Option<Jwk>,
    meta: EngineMeta,
    captured: Option<Arc<dyn CapturedSource>>,
    users: Option<Arc<dyn UserRecords>>,
    prover: Option<Arc<Prover>>,
    c1: C1Proofs,
    log: Option<Arc<LogSigner>>,
    /// The Alibi origins' log keys leg A holds, `(origin, Ed25519 key)`: leg A's own, or on leg B
    /// the ones its boot message carried with a KMS chain that verified.
    tee_log_keys: Vec<(&'static str, [u8; 32])>,
}

/// What leg A needs to prove C1 for an ALLOW it already answered.
struct C1Job {
    sub: String,
    sealed_salt: Vec<u8>,
    mandate_hash: [u8; 32],
    mandate: Value,
    merchant: String,
    statement: Statement,
}

enum C1Slot {
    Queued(Box<C1Job>),
    Proving,
    /// `None` when the proof could not be made.
    Done(Option<ZkProof>),
}

/// The C1 proofs of the latest ALLOWs, by request id, proved after the countersign is answered.
#[derive(Default)]
struct C1Proofs {
    slots: Mutex<(HashMap<String, C1Slot>, VecDeque<String>)>,
    done: Condvar,
}

/// How many requests' proofs leg A keeps; the API fetches each one seconds after its countersign.
const C1_KEPT: usize = 4096;

/// The proof of a request as [`Engine::c1`] finds it.
#[derive(Debug, PartialEq, Eq)]
pub enum C1Status {
    Ready(ZkProof),
    /// Not proved yet when the wait ended.
    Pending,
    /// Never queued, forgotten, or not provable.
    None,
}

/// A closed mandate whose signatures, key binding and passkey assertion all verified.
struct Authenticated {
    /// The mandate, without the delegate payload's `cnf`.
    mandate: Value,
    mandate_hash: [u8; 32],
    commitment: [u8; 32],
    user_key: Jwk,
}

impl Engine {
    /// Boots now with a fresh signer.
    ///
    /// # Panics
    ///
    /// If the chain is neither Arbitrum Sepolia nor Arbitrum One.
    pub fn new(config: EngineConfig, root: Option<Root>) -> Self {
        Self::booted_at(config, root, OffsetDateTime::now_utc())
    }

    /// [`Engine::new`] with the boot time given.
    ///
    /// # Panics
    ///
    /// If the chain is neither Arbitrum Sepolia nor Arbitrum One.
    pub fn booted_at(config: EngineConfig, root: Option<Root>, boot: OffsetDateTime) -> Self {
        keelson_core::domain(config.chain_id, config.verifying_contract)
            .expect("the engine runs on Arbitrum Sepolia or Arbitrum One");
        let issuer = match &root {
            Some(root) => Some(jwk_of(&root.issuer_key())),
            None => config.issuer.clone(),
        };
        Self {
            signer: Signer::generate(),
            meta: EngineMeta::current(&config.oci_digest, &config.canonicalizer),
            root,
            config,
            boot,
            budget: Budget::default(),
            cards: CardLedger::default(),
            issuer,
            captured: None,
            users: None,
            prover: None,
            c1: C1Proofs::default(),
            log: None,
            tee_log_keys: Vec::new(),
        }
    }

    /// Sets the checkpoint signer of the Alibi origins, which leg A holds.
    pub fn with_log_signer(mut self, log: Arc<LogSigner>) -> Self {
        self.tee_log_keys = log
            .keys()
            .iter()
            .map(|k| (k.origin, k.public_key()))
            .collect();
        self.log = Some(log);
        self
    }

    /// Sets the log keys leg A holds, for a leg that verifies checkpoints but does not sign them.
    pub fn with_tee_log_keys(mut self, keys: Vec<(&'static str, [u8; 32])>) -> Self {
        self.tee_log_keys = keys;
        self
    }

    /// Signs the RA-TLS binding digest of [`crate::ratls::binding_digest`] with the attested
    /// signer.
    pub fn sign_tls_binding(&self, digest: &[u8; 32]) -> Result<[u8; 65], Error> {
        self.signer.sign_tls_binding(digest)
    }

    /// The log keys this engine trusts for the Alibi origins.
    pub fn tee_log_keys(&self) -> &[(&'static str, [u8; 32])] {
        &self.tee_log_keys
    }

    /// The checkpoint signer, on leg A.
    pub fn log_signer(&self) -> Option<&LogSigner> {
        self.log.as_deref()
    }

    /// Signs a log checkpoint that extends the last one signed for its origin, or the origin's
    /// on-chain anchor `floor` when the leg has signed none.
    pub fn sign_log(
        &self,
        r: &SignRequest,
        floor: Option<(u64, [u8; 32])>,
    ) -> Result<Signed, EngineError> {
        let (Some(log), Some(root)) = (&self.log, &self.root) else {
            return Err(EngineError::NoRoot);
        };
        log.sign(root, floor, r).map_err(EngineError::Log)
    }

    /// Whether signing a checkpoint of `origin` needs its on-chain anchor first.
    pub fn log_needs_floor(&self, origin: &str) -> Result<bool, EngineError> {
        let (Some(log), Some(root)) = (&self.log, &self.root) else {
            return Ok(false);
        };
        log.needs_floor(root, origin).map_err(EngineError::Log)
    }

    /// Sets the captured amounts leg A counts against each budget.
    pub fn with_captured(mut self, captured: Arc<dyn CapturedSource>) -> Self {
        self.captured = Some(captured);
        self
    }

    /// Sets the C1 prover leg A proves every ALLOW of a request carrying the mandate's sealed salt
    /// with.
    pub fn with_prover(mut self, prover: Arc<Prover>) -> Self {
        self.prover = Some(prover);
        self
    }

    /// Sets where leg A keeps the sealed user records.
    pub fn with_user_records(mut self, users: Arc<dyn UserRecords>) -> Self {
        self.users = Some(users);
        self
    }

    /// The boot configuration.
    pub fn config(&self) -> &EngineConfig {
        &self.config
    }

    /// The boot time, in Unix seconds.
    pub fn boot_epoch(&self) -> u64 {
        u64::try_from(self.boot.unix_timestamp()).unwrap_or_default()
    }

    /// The countersign signer's address.
    pub fn signer(&self) -> Address {
        self.signer.address()
    }

    /// The signer's uncompressed SEC1 public key.
    pub fn signer_public_key(&self) -> [u8; 65] {
        self.signer.public_key_sec1()
    }

    /// The credential issuer's public key: derived from the root on leg A, configured on leg B.
    pub fn issuer(&self) -> Option<&Jwk> {
        self.issuer.as_ref()
    }

    /// What the attestation binds this engine's signer to on its own chain; the engine build id
    /// is the image digest.
    pub fn binding(&self) -> Result<SignerBinding, Error> {
        self.binding_for(self.config.chain_id)
    }

    /// [`Engine::binding`] on `chain_id`, one of the chains `keelson_core::domain` accepts.
    pub fn binding_for(&self, chain_id: u64) -> Result<SignerBinding, Error> {
        crate::error::check_chain(chain_id)?;
        let engine_build_id = self
            .config
            .oci_digest
            .strip_prefix("sha256:")
            .and_then(|digest| wire::parse_hex(&format!("0x{digest}")))
            .ok_or(Error::OciDigest)?;
        Ok(SignerBinding {
            chain_id,
            bond_vault: self.config.bond_vault,
            tee_kind: self.config.tee_kind,
            signer: self.signer(),
            policy_set_hash: policy_set_hash(),
            engine_build_id,
            boot_epoch: self.boot_epoch(),
            issuer_jwk_thumbprint: self.issuer.as_ref().ok_or(Error::NoIssuer)?.thumbprint(),
        })
    }

    /// Verifies the passkey assertion over a mandate and issues its open mandate, and the user
    /// credential when the request has none.
    pub fn register_mandate(
        &self,
        r: &RegisterMandate,
        now: OffsetDateTime,
    ) -> Result<MandateIssued, EngineError> {
        let root = self.root.as_ref().ok_or(EngineError::NoRoot)?;
        check_register(r)?;
        let m = decode_mandate(&r.payload_sd, &r.disclosures).map_err(|_| bad("mandate"))?;
        if m["user"]["sub"] != r.sub.as_str() {
            return Err(bad("sub"));
        }
        let at = now.unix_timestamp();
        match (m["nbf"].as_i64(), m["exp"].as_i64()) {
            (Some(nbf), Some(exp)) => {
                if exp <= at {
                    return Err(EngineError::Expired);
                }
                if nbf > at {
                    return Err(EngineError::NotYetValid);
                }
            }
            _ => return Err(bad("mandate")),
        }
        let cm = mandate_commitment(&m, r.salt).map_err(|_| bad("mandate"))?;
        if Some(field_bytes(&cm)) != commitment(&m) {
            return Err(EngineError::CommitmentMismatch);
        }
        let h = h_sd(&r.payload_sd).map_err(|_| bad("mandate"))?;
        let mandate_hash = mandate_challenge(&h, &cm);
        // Every verifier, the Alibi's included, reads `embed` in clear.
        if r.payload_sd.get("embed") != m.get("embed") {
            return Err(bad("embed"));
        }
        verify_user_auth(
            &(&r.assertion).into(),
            &m,
            mandate_hash,
            &self.config.origin,
        )?;

        let cred = &m["user"]["cred"];
        let holder = root.user_key(&r.sub);
        let passkey = Jwk::from_value(&cred["jwk"]).map_err(|_| bad("mandate"))?;
        if let Some(l1) = &r.user_credential {
            let id = cred["id"].as_str().unwrap_or_default();
            self.check_user_credential(l1, &r.sub, &jwk_of(&holder), id, &passkey)?;
        }
        let iat = now.unix_timestamp();
        let user_credential = match &r.user_credential {
            Some(l1) => l1.clone(),
            None => issue_user_credential(
                &UserCredentialParams {
                    iss: ISSUER.into(),
                    sub: r.sub.clone(),
                    cred: PasskeyCredential {
                        id: cred["id"].as_str().unwrap_or_default().into(),
                        rp_id: RP_ID.into(),
                        jwk: passkey,
                    },
                    holder_jwk: jwk_of(&holder),
                },
                &root.issuer_key(),
                &mut random_salt,
                iat,
            )
            .map_err(|_| bad("user credential"))?,
        };
        let open_mandate = issue_open_mandate(
            &OpenMandateParams {
                user_credential: user_credential.clone(),
                payload_sd: r.payload_sd.clone(),
                disclosures: r.disclosures.clone(),
                user_auth: UserAuth {
                    authenticator_data: r.assertion.authenticator_data.clone(),
                    client_data_json: r.assertion.client_data_json.clone(),
                    signature: r.assertion.signature.clone(),
                },
                aud: OPEN_MANDATE_AUD.into(),
                nonce: m["mid"].as_str().unwrap_or_default().into(),
            },
            &holder,
            &mut random_salt,
            iat,
        )
        .map_err(|_| bad("open mandate"))?;
        let aad = SealAad {
            purpose: MANDATE_SALT_PURPOSE,
            sub: Some(&r.sub),
            record: &mandate_hash,
        };
        Ok(MandateIssued {
            mandate_hash: Hex(mandate_hash),
            user_credential,
            open_mandate,
            sealed_salt: Base64(root.seal(&aad, &r.salt)),
        })
    }

    /// Authenticates the closed mandate, evaluates the cart against it and signs the
    /// `Countersign`, ALLOW or DENY.
    ///
    /// Leg A computes the budget from its own ledger and captured amounts, reserves an ALLOW's
    /// amount until it expires, and refuses a request that carries an observation. Leg B
    /// requires leg A's observation and reserves nothing. A request id is answered once: the
    /// same input gets the same countersign, any other input under the id is a replay.
    pub fn countersign(
        &self,
        r: &CountersignRequest,
        clock_now: OffsetDateTime,
    ) -> Result<Countersigned, EngineError> {
        self.countersign_with(r, clock_now, None)
    }

    /// Signs the `Checkpoint` of a witnessed log checkpoint: the note must verify against its
    /// origin's log key and witness quorum, and the origin must anchor on the request's chain.
    /// The signature means the log signed and its witnesses cosigned that tree.
    pub fn sign_checkpoint(
        &self,
        r: &CheckpointRequest,
        now: OffsetDateTime,
    ) -> Result<CheckpointSigned, EngineError> {
        let chain_id = r.chain_id.unwrap_or(self.config.chain_id);
        let c = verify_checkpoint(r.signed_note.as_bytes(), chain_id, now, &self.tee_log_keys)
            .map_err(EngineError::Checkpoint)?;
        let domain = keelson_core::domain(chain_id, self.config.verifying_contract)
            .map_err(|_| bad("chain_id"))?;
        let signature = self
            .signer
            .sign_checkpoint(&c, &domain)
            .map_err(EngineError::Signer)?;
        Ok(CheckpointSigned {
            origin: Hex(c.origin.0),
            tree_size: c.treeSize.to_string(),
            root_hash: Hex(c.rootHash.0),
            chain_id,
            digest: Hex(alloy_sol_types::SolStruct::eip712_signing_hash(&c, &domain).0),
            signature: Hex(signature),
            signer: self.signer.address(),
        })
    }

    /// Signs the EIP-712 `WebFact` for a TLS session the notary accepted: `server_name` served
    /// a body range committing to `commitment` in answer to a `GET` of `target`, at `now`.
    /// `attId` is the signer binding the attestation covers, the first half of its report data.
    pub fn sign_web_fact(
        &self,
        server_name: &str,
        target: &str,
        commitment: [u8; 32],
        now: OffsetDateTime,
    ) -> Result<WebFactSigned, EngineError> {
        let chain_id = self.config.chain_id;
        let domain = keelson_core::domain(chain_id, self.config.verifying_contract)
            .map_err(|_| bad("chain_id"))?;
        let binding = crate::report_data(&self.binding().map_err(EngineError::Signer)?, [0; 32])
            .map_err(EngineError::Signer)?;
        // DNS names compare without case; the hash is over the lowercase name.
        let fact = WebFact {
            hostHash: alloy_primitives::keccak256(server_name.to_ascii_lowercase()),
            urlPathHash: alloy_primitives::keccak256(target),
            tCapture: U40::from(u64::try_from(now.unix_timestamp()).map_err(|_| bad("clock"))?),
            rangeCommitment: B256::new(commitment),
            attId: B256::from_slice(&binding[..32]),
        };
        let signature = self
            .signer
            .sign_web_fact(&fact, &domain)
            .map_err(EngineError::Signer)?;
        Ok(WebFactSigned {
            web_fact: WebFactJson {
                host_hash: Hex(fact.hostHash.0),
                url_path_hash: Hex(fact.urlPathHash.0),
                t_capture: now.unix_timestamp(),
                range_commitment: Hex(commitment),
                att_id: Hex(fact.attId.0),
            },
            chain_id,
            digest: Hex(alloy_sol_types::SolStruct::eip712_signing_hash(&fact, &domain).0),
            signature: Hex(signature),
            signer: self.signer.address(),
        })
    }

    /// Attributes a dispute from `r.facts` with the attribution policy sets and signs the
    /// resulting EIP-712 `Verdict`. The caller supplies the facts and the settlement terms; the
    /// rule, the liable party and which failed field the verdict names are the engine's.
    pub fn sign_verdict(&self, r: &VerdictRequest) -> Result<VerdictSigned, EngineError> {
        let chain_id = r.chain_id.unwrap_or(self.config.chain_id);
        let domain = keelson_core::domain(chain_id, self.config.verifying_contract)
            .map_err(|_| bad("chain_id"))?;
        let i = &r.input;
        let rule = keelson_policy::attribute(&r.facts)
            .map_err(|_| bad("facts"))?
            .rule;
        let field = match rule {
            60 => i.failed_fields.green,
            61 => i.failed_fields.amber,
            62 => i.failed_fields.gray,
            _ => None,
        };
        let input = VerdictInput {
            paypal_dispute_id: &i.paypal_dispute_id,
            coverage_id: B256::new(i.coverage_id.0),
            agent_id: i.agent_id.parse::<U256>().map_err(|_| bad("agent_id"))?,
            payee: i.payee,
            amount: i.amount.parse().map_err(|_| bad("amount"))?,
            field_id: field.unwrap_or(keelson_policy::NO_FIELD),
            evidence_hash: B256::new(i.evidence_hash.0),
            checkpoint_root: B256::new(i.checkpoint_root.0),
            issued_at: i.issued_at,
            deadline: i.deadline,
        };
        let v = keelson_policy::verdict(&r.facts, &input).map_err(|e| {
            bad(match e {
                VerdictError::Attribution(_) => "facts",
                VerdictError::EmptyDisputeId => "paypal_dispute_id",
                VerdictError::AmountTooLarge => "amount",
                VerdictError::TimeTooLarge | VerdictError::DeadlineNotAfterIssue => "deadline",
                VerdictError::FieldRequired(_)
                | VerdictError::FieldNotApplicable(_)
                | VerdictError::FieldOutOfRange(_) => "field_id",
            })
        })?;
        let signature = self
            .signer
            .sign_verdict(&v, &domain)
            .map_err(EngineError::Signer)?;
        Ok(VerdictSigned {
            verdict: (&v).into(),
            chain_id,
            digest: Hex(alloy_sol_types::SolStruct::eip712_signing_hash(&v, &domain).0),
            signature: Hex(signature),
            signer: self.signer.address(),
            tee: self.config.tee_kind,
        })
    }

    /// Checks a card network authorization against the ALLOW its single-use card was issued
    /// under, and signs the EIP-712 `CardAuthorization`, approve or decline.
    ///
    /// The countersign must be this leg's own ALLOW, over the card mandate the request carries.
    /// The authorization passes only within the countersign's lifetime, in its currency, for at
    /// most its amount, at a merchant category code and country the mandate allows for its
    /// merchant, and as the card's first approved authorization. The answer to an approved
    /// authorization id is the same on every retry.
    pub fn authorize_card(
        &self,
        r: &CardAuthorizeRequest,
        now: OffsetDateTime,
    ) -> Result<CardAuthorized, EngineError> {
        let n = &r.authorization;
        for (s, what) in [
            (&n.id, "authorization.id"),
            (&n.merchant_name, "authorization.merchant_name"),
            (&n.network_id, "authorization.network_id"),
        ] {
            within(s, MAX_STRING, what)?;
        }
        if r.disclosures.len() > MAX_DISCLOSURES {
            return Err(EngineError::TooLarge("disclosures"));
        }
        for d in &r.disclosures {
            within(d, MAX_PART, "disclosure")?;
        }
        let payload = serde_json::to_vec(&r.payload_sd).map_err(|_| bad("payload_sd"))?;
        if payload.len() > MAX_PAYLOAD {
            return Err(EngineError::TooLarge("payload_sd"));
        }
        let chain_id = r.chain_id.unwrap_or(self.config.chain_id);
        let domain = keelson_core::domain(chain_id, self.config.verifying_contract)
            .map_err(|_| bad("chain_id"))?;
        let c = countersign_of(&r.countersign)?;
        let digest = countersign_digest(&c, &domain);
        if !self.signer.signed(&digest, &r.signature.0) {
            return Err(bad("signature"));
        }
        let m = decode_mandate(&r.payload_sd, &r.disclosures).map_err(|_| bad("mandate"))?;
        let cm = commitment(&m).ok_or(bad("mandate"))?;
        let h = h_sd(&r.payload_sd).map_err(|_| bad("mandate"))?;
        let mandate_hash = mandate_challenge(&h, &Fr::from_be_bytes_reduce(&cm));
        if mandate_hash != c.mandateHash.0 {
            return Err(bad("mandate"));
        }
        let mcc: u16 = match n.mcc.as_bytes() {
            [a, b, c, d] if [a, b, c, d].iter().all(|x| x.is_ascii_digit()) => {
                n.mcc.parse().map_err(|_| bad("authorization.mcc"))?
            }
            _ => return Err(bad("authorization.mcc")),
        };
        let country: [u8; 2] = match n.merchant_country.as_bytes() {
            [a, b] if a.is_ascii_uppercase() && b.is_ascii_uppercase() => [*a, *b],
            _ => return Err(bad("authorization.merchant_country")),
        };
        let amount =
            u64::try_from(n.amount_minor).map_err(|_| bad("authorization.amount_minor"))?;
        let now_s = now.unix_timestamp();
        let expires_at = i64::try_from(c.expiresAt.to::<u64>()).map_err(|_| bad("countersign"))?;

        // Every check is evaluated, so the mask names every reason to decline.
        let mut failed = 0;
        if c.decision != 1 {
            failed |= card_bit("decision");
        }
        if m["payment"]["rail"] != "card" {
            failed |= card_bit("rail");
        }
        if now_s >= expires_at {
            failed |= card_bit("expired");
        }
        if currency_numeric(&n.currency).ok() != Some(c.currency) {
            failed |= card_bit("currency");
        }
        if amount == 0 || amount > c.amount {
            failed |= card_bit("amount");
        }
        let allowed = constraint(&m, "checkout", "checkout.allowed_merchants")["allowed"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|x| {
                x["id"]
                    .as_str()
                    .and_then(|id| merchant_leaf(id).ok())
                    .is_some_and(|leaf| field_bytes(&leaf) == c.merchantId.0)
            });
        match allowed {
            None => failed |= card_bit("merchant"),
            Some(x) => {
                let codes = x["mcc"].as_array().into_iter().flatten();
                if !codes
                    .into_iter()
                    .any(|k| k.as_str() == Some(n.mcc.as_str()))
                {
                    failed |= card_bit("mcc");
                }
                if x["country"].as_str() != Some(n.merchant_country.as_str()) {
                    failed |= card_bit("country");
                }
            }
        }
        let mandate_exp = m["exp"].as_i64().ok_or(bad("mandate"))?;
        let merchant_hash = alloy_primitives::keccak256(
            [n.network_id.as_bytes(), &[0], n.merchant_name.as_bytes()].concat(),
        );
        let request_id = c.requestId.0;
        let durable = match (&self.root, &self.users) {
            (Some(root), Some(users)) => Some(DurableCards {
                root,
                users: users.as_ref(),
            }),
            _ => None,
        };
        self.cards.decide(request_id, &n.id, now_s, |used| {
            let mut failed = failed | if used { card_bit("used") } else { 0 };
            // Leg A's approval holds across restarts: the card's use and the mandate's charge
            // are sealed into its records before it is signed.
            if let (0, Some(d)) = (failed, &durable) {
                if !d.claim_use(&request_id, &n.id) {
                    failed |= card_bit("used");
                } else if !d.record_spend(&mandate_hash, &request_id, n.amount_minor) {
                    return Err(EngineError::Busy);
                }
            }
            let a = CardAuthorization {
                requestId: c.requestId,
                countersignDigest: B256::new(digest),
                authorizationHash: alloy_primitives::keccak256(n.id.as_bytes()),
                merchantHash: merchant_hash,
                mcc,
                country: alloy_primitives::FixedBytes(country),
                amount,
                currency: currency_numeric(&n.currency).unwrap_or(0),
                decision: if failed == 0 { 1 } else { 2 },
                failedMask: failed,
                issuedAt: uint40(now_s)?,
            };
            let signature = self
                .signer
                .sign_card_authorization(&a, &domain)
                .map_err(EngineError::Signer)?;
            Ok(Approval {
                out: CardAuthorized {
                    authorization: (&a).into(),
                    chain_id,
                    digest: Hex(alloy_sol_types::SolStruct::eip712_signing_hash(&a, &domain).0),
                    signature: Hex(signature),
                    signer: self.signer.address(),
                    tee: self.config.tee_kind,
                },
                approves: failed == 0,
                mandate_hash,
                mandate_exp,
                amount: n.amount_minor,
                forget_at: expires_at.max(now_s).saturating_add(COUNTERSIGN_TTL),
            })
        })
    }

    /// [`Engine::countersign`] on leg A over a PayPal reading made for this request.
    ///
    /// With `paypal`, the amount captured is the one it reports, and the cart is denied unless
    /// the authorization can back it (see [`PayPalDeny`]). Without it, the amount comes from the
    /// [`CapturedSource`]. Leg B takes the reading from the request's observation and refuses
    /// one passed here.
    pub fn countersign_with(
        &self,
        r: &CountersignRequest,
        clock_now: OffsetDateTime,
        paypal: Option<PayPalObservation>,
    ) -> Result<Countersigned, EngineError> {
        check_countersign(r)?;
        let chain_id = r.chain_id.unwrap_or(self.config.chain_id);
        let domain = keelson_core::domain(chain_id, self.config.verifying_contract)
            .map_err(|_| bad("chain_id"))?;
        // Leg A without a PayPal reading reads what was spent from its captured source, or for a
        // card mandate from its own card ledger; which one is known once the mandate is read.
        let ledger = match (&self.root, &r.observation, &paypal) {
            (Some(_), Some(_), _) | (None, None, _) | (None, _, Some(_)) => {
                return Err(bad("observation"));
            }
            (Some(_), None, None) => true,
            (Some(_), None, Some(_)) | (None, Some(_), None) => false,
        };
        let observed = paypal
            .as_ref()
            .or(r.observation.as_ref().map(|o| &o.paypal));
        let clock_ms = unix_ms(clock_now).ok_or(bad("clock"))?;
        let now_ms = match &r.observation {
            Some(o)
                if o.now_ms > clock_ms + MAX_OBSERVATION_AHEAD_MS
                    || o.now_ms < clock_ms - MAX_SKEW_SEC * 1000 =>
            {
                return Err(EngineError::Clock);
            }
            Some(o) => o.now_ms,
            None => clock_ms,
        };
        let now = OffsetDateTime::from_unix_timestamp_nanos(i128::from(now_ms) * 1_000_000)
            .map_err(|_| bad("clock"))?;
        let now_s = now_ms.div_euclid(1000);
        // A request id is accepted only while a record for it could still be live, so it can
        // never be signed again once its record has expired, across restarts too. The window is
        // read on this engine's own clock, which the caller cannot move.
        let id_ms = i64::try_from(r.request_id.timestamp_ms()).map_err(|_| EngineError::Replay)?;
        let skew_ms = MAX_SKEW_SEC * 1000;
        if id_ms <= clock_ms - COUNTERSIGN_TTL * 1000 + skew_ms || id_ms > clock_ms + skew_ms {
            return Err(EngineError::Replay);
        }
        let forged = |e: &String| e.starts_with("ucp:") || e.starts_with("zktls:");
        if r.evidence.values().flatten().any(forged) {
            return Err(bad("evidence"));
        }
        let cart_hash = cart_hash(&r.cart).map_err(|_| bad("cart"))?;
        let a = self.authenticate(r, now_s, &cart_hash)?;
        // Bind the request id to its whole input before anything is evaluated or reserved.
        // The record holds the reservation and expires with the countersign; dropping the claim
        // without an answer removes both.
        let exp = a.mandate["exp"].as_i64().ok_or(bad("mandate"))?;
        let expires_at = now_s.saturating_add(COUNTERSIGN_TTL).min(exp);
        let until = OffsetDateTime::from_unix_timestamp(expires_at).map_err(|_| bad("clock"))?;
        let digest = request_digest(r)?;
        let claim = match self
            .budget
            .claim(&a.mandate_hash, r.request_id, digest, until, now)
        {
            Err(Replay) => return Err(EngineError::Replay),
            Ok(Claimed::Answered(out)) => return Ok(*out),
            Ok(Claimed::Full) => return Err(EngineError::Busy),
            Ok(Claimed::Working(claim)) => claim,
        };
        let expires_at = claim.expires_at().unix_timestamp();

        // Everything that can fail is read before any budget is reserved.
        let m = &a.mandate;
        let budget_max = constraint(m, "payment", "payment.budget")["max"]
            .as_i64()
            .ok_or(bad("mandate"))?;
        let operator = &m["agent"]["operator"];
        let agent_id = operator["agent_id"].as_str().unwrap_or_default();
        let agent = agent_uid(
            operator["agent_registry"].as_str().unwrap_or_default(),
            agent_id,
        )
        .ok_or(bad("mandate"))?;
        let agent_id = U256::from_str_radix(agent_id, 10).map_err(|_| bad("mandate"))?;
        let merchant = merchant_leaf(&r.cart.merchant).map_err(|_| bad("merchant"))?;
        let (issued_at, expires) = (uint40(now_s)?, uint40(expires_at)?);
        let context = canonicalize(&r.cart, &r.unit);
        let total = context.as_ref().map_or(0, |c| c.total_minor);
        let amount = u64::try_from(total).map_err(|_| bad("cart"))?;
        // A card mandate spends on single-use cards. Leg A counts what its cards approved from
        // its sealed records and, when the mandate's PayPal hold is read, counts the charges
        // already collected from the hold as PayPal reports them and the rest from the records.
        let card = m["payment"]["rail"] == "card";
        let spends = match (&self.root, &self.users) {
            (Some(root), Some(users)) if card => DurableCards {
                root,
                users: users.as_ref(),
            }
            .spends(&a.mandate_hash),
            _ => Vec::new(),
        };
        let recorded = |collected: &BTreeMap<Ulid, i64>| {
            spends
                .iter()
                .filter(|(id, _)| {
                    let ulid =
                        Ulid::from(u128::from_be_bytes(id[16..].try_into().expect("16 bytes")));
                    !collected.contains_key(&ulid)
                })
                .fold(0i64, |n, (_, amount)| n.saturating_add(*amount))
        };
        let captured = match (ledger, &paypal) {
            (true, _) if card => self
                .cards
                .spent(&a.mandate_hash, now_s)
                .max(recorded(&BTreeMap::new())),
            (false, Some(read)) if card => read
                .captured_minor
                .max(read.order_captured_minor)
                .max(0)
                .saturating_add(recorded(&read.captured_by_request)),
            // A negative capture would raise the budget past its max.
            (true, _) => self
                .captured
                .as_ref()
                .ok_or(EngineError::NotReady)?
                .captured_minor(&a.mandate_hash)
                .ok_or(EngineError::NotReady)?
                .max(0),
            // Every capture of the order spends the mandate, a reauthorized parent's included.
            (false, Some(read)) => read.captured_minor.max(read.order_captured_minor).max(0),
            (false, None) => 0,
        };
        let no_captures = BTreeMap::new();
        let captured_by = paypal
            .as_ref()
            .map_or(&no_captures, |read| &read.captured_by_request);
        // An empty reading is leg A's without a PayPal read, which checks nothing.
        let live = chain_id == ARBITRUM_ONE;
        let denied = match (&context, observed) {
            (Ok(c), Some(o)) if !o.authorization_id.is_empty() => {
                match paypal_check(m, o, c, &r.request_id.to_string(), live) {
                    Err(deny) => Some(deny),
                    // A purchase hold names its request id, which the ledger answers once.
                    Ok(HoldKind::Purchase) => None,
                    // Only leg A keeps the record of which order holds a mandate.
                    Ok(HoldKind::Mandate) => match (&self.root, &self.users) {
                        (Some(root), Some(users)) => {
                            let mid = m["mid"].as_str().unwrap_or_default();
                            bind_hold(root, users.as_ref(), mid, &o.order_id).err()
                        }
                        (Some(_), None) => return Err(EngineError::NotReady),
                        (None, _) => None,
                    },
                }
            }
            _ => None,
        };
        let warming_up = clock_now < self.boot + Duration::seconds(COUNTERSIGN_TTL);

        let (out, statement) = loop {
            let budget_left = match &r.observation {
                Some(o) => o.budget_left_minor,
                // While warming up nothing above zero is allowed, and never more than is left.
                None if warming_up => claim.left(budget_max, captured, captured_by, now).min(0),
                None => claim.left(budget_max, captured, captured_by, now),
            };
            let trace = match &context {
                Ok(_) if denied.is_some() => {
                    let reason = denied.map_or("", PayPalDeny::as_str);
                    deny_trace(reason, now, &a.mandate_hash, &cart_hash, &self.meta)
                }
                // The KB-JWT signer is the mandate's `cnf`, so the mandate's agent is the
                // authenticated requester.
                _ => cart_trace(
                    &context,
                    |context| EvalInput {
                        mandate: m.clone(),
                        budget_left_minor: budget_left,
                        agent: agent.clone(),
                        context,
                        now,
                        evidence: r.evidence.clone(),
                        mandate_hash: a.mandate_hash,
                        cart_hash,
                    },
                    now,
                    &a.mandate_hash,
                    &cart_hash,
                    &self.meta,
                ),
            };
            let canon = context.as_ref().err();
            let jcs = trace_jcs(&trace);
            let eval_hash = eval_hash(&jcs);
            let allow = trace.decision == Decision::Allow;
            let cedar_errors = canon.is_none() && denied.is_none() && !trace.errors.is_empty();
            let c = Countersign {
                requestId: B256::left_padding_from(&r.request_id.to_bytes()),
                mandateHash: B256::new(a.mandate_hash),
                mandateCommitment: B256::new(a.commitment),
                cartHash: B256::new(cart_hash),
                agentId: agent_id,
                merchantId: B256::new(field_bytes(&merchant)),
                amount,
                // A currency without an ISO 4217 number fails canonicalization or the currency
                // policy, so 0 is only ever signed on a DENY.
                currency: currency_numeric(&r.cart.currency).unwrap_or(0),
                category: category(&r.cart),
                evidenceRoot: B256::new(r.evidence_root.0),
                evalHash: B256::new(eval_hash),
                policySetHash: B256::new(policy_set_hash()),
                decision: if allow { 1 } else { 2 },
                failedFieldsMask: failed_fields_mask(
                    &trace.fired,
                    cedar_errors,
                    canon.is_some(),
                    denied.is_some(),
                ),
                issuedAt: issued_at,
                expiresAt: expires,
            };
            let signature = self
                .signer
                .sign_countersign(&c, &domain)
                .map_err(EngineError::Signer)?;
            // Reserving is the last step, so no failure can leave a reservation behind. Cedar allowed `total ≤ budget_left`, so a failed reservation means another request
            // reserved since, and evaluating again makes progress. A zero total reserves nothing.
            if allow
                && total > 0
                && r.observation.is_none()
                && !claim
                    .reserve(budget_max, captured, captured_by, total, now)
                    .map_err(|Replay| EngineError::Replay)?
            {
                continue;
            }
            let statement = allow.then(|| Statement {
                c_m: Fr::from_be_bytes_reduce(&a.commitment),
                amount,
                currency: c.currency,
                category: c.category,
                merchant_id: merchant,
                now: u64::try_from(now_s).unwrap_or_default(),
                cart_hash: Fr::from_be_bytes_reduce(&cart_hash),
                operator_id: Fr::from_be_bytes_reduce(&agent_id.to_be_bytes::<32>()),
            });
            break (
                Countersigned {
                    countersign: (&c).into(),
                    digest: Hex(countersign_digest(&c, &domain)),
                    signature: Hex(signature),
                    signer: self.signer.address(),
                    tee: self.config.tee_kind,
                    trace_jcs: Base64(jcs),
                    observation: Observation {
                        now_ms,
                        budget_left_minor: budget_left,
                        user_key: a.user_key.clone(),
                        paypal: observed.cloned().unwrap_or_default(),
                    },
                },
                statement,
            );
        };
        let answered = claim.answer(out).map_err(|Replay| EngineError::Replay)?;
        if let (Some(statement), Some(_), Some(_), Some(sealed)) =
            (statement, &self.prover, &self.root, &r.sealed_salt)
        {
            self.queue_c1(
                r.request_id.to_string(),
                C1Job {
                    sub: r.sub.clone(),
                    sealed_salt: sealed.0.clone(),
                    mandate_hash: a.mandate_hash,
                    mandate: a.mandate,
                    merchant: r.cart.merchant.clone(),
                    statement,
                },
            );
        }
        Ok(answered)
    }

    /// Whether this leg proves C1 for the ALLOWs it answers ([`Engine::prove_c1`]).
    pub fn proves_c1(&self) -> bool {
        self.prover.is_some() && self.root.is_some()
    }

    fn queue_c1(&self, request_id: String, job: C1Job) {
        let mut guard = self
            .c1
            .slots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (slots, order) = &mut *guard;
        if slots.contains_key(&request_id) {
            return;
        }
        while order.len() >= C1_KEPT {
            if let Some(old) = order.pop_front()
                && matches!(
                    slots.remove(&old),
                    Some(C1Slot::Queued(_) | C1Slot::Proving)
                )
            {
                eprintln!("keelson-engine: C1 proof of request {old} dropped unproved");
            }
        }
        order.push_back(request_id.clone());
        slots.insert(request_id, C1Slot::Queued(Box::new(job)));
    }

    /// Proves C1 for the ALLOW answered under `request_id`, from the salt sealed to the request's
    /// user and `M`. Runs once per request; a proof that cannot be made is recorded as none: the
    /// countersign stands on its signatures alone.
    pub fn prove_c1(&self, request_id: &str) {
        let job = {
            let mut guard = self
                .c1
                .slots
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match guard.0.get_mut(request_id) {
                Some(slot @ C1Slot::Queued(_)) => match std::mem::replace(slot, C1Slot::Proving) {
                    C1Slot::Queued(job) => job,
                    _ => unreachable!(),
                },
                _ => return,
            }
        };
        let proof = self.prove_job(&job).map_err(|e| {
            eprintln!("keelson-engine: no C1 proof for request {request_id}: {e}");
        });
        let mut guard = self
            .c1
            .slots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(slot) = guard.0.get_mut(request_id) {
            *slot = C1Slot::Done(proof.ok());
        }
        self.c1.done.notify_all();
    }

    /// Gives up proving `request_id`: its proof is served as none.
    pub fn forgo_c1(&self, request_id: &str) {
        let mut guard = self
            .c1
            .slots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(slot @ C1Slot::Queued(_)) = guard.0.get_mut(request_id) {
            *slot = C1Slot::Done(None);
        }
    }

    /// The C1 proof of `request_id`, waiting up to `wait` for one still being proved.
    pub fn c1(&self, request_id: &str, wait: std::time::Duration) -> C1Status {
        let guard = self
            .c1
            .slots
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (guard, _) = self
            .c1
            .done
            .wait_timeout_while(guard, wait, |(slots, _)| {
                matches!(
                    slots.get(request_id),
                    Some(C1Slot::Queued(_) | C1Slot::Proving)
                )
            })
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match guard.0.get(request_id) {
            Some(C1Slot::Done(Some(p))) => C1Status::Ready(p.clone()),
            Some(C1Slot::Queued(_) | C1Slot::Proving) => C1Status::Pending,
            Some(C1Slot::Done(None)) | None => C1Status::None,
        }
    }

    fn prove_job(&self, job: &C1Job) -> Result<ZkProof, String> {
        let (Some(prover), Some(root)) = (self.prover.as_ref(), self.root.as_ref()) else {
            return Err("this leg does not prove".to_owned());
        };
        let aad = SealAad {
            purpose: MANDATE_SALT_PURPOSE,
            sub: Some(&job.sub),
            record: &job.mandate_hash,
        };
        let salt = root
            .unseal(&aad, &job.sealed_salt)
            .map_err(|e| e.to_string())?;
        let salt: [u8; 16] = salt
            .try_into()
            .map_err(|_| "the sealed salt is not 16 bytes")?;
        let opening = mandate_opening(&job.mandate, salt).map_err(|e| e.to_string())?;
        if opening.commitment() != job.statement.c_m {
            return Err("the sealed salt does not open the commitment".to_owned());
        }
        let merchant =
            merchant_membership(&opening.merchants, &job.merchant).map_err(|e| e.to_string())?;
        prover
            .prove(&job.statement, &opening, &merchant)
            .map(|p| ZkProof::from(&p))
            .map_err(|e| e.to_string())
    }

    /// Verifies the closed mandate against the issuer key, binds its user credential to the
    /// request's user, and verifies the user's passkey assertion over `M`.
    ///
    /// With a root the holder key is `user_key(sub)`; without one it is the observation's, so
    /// only leg A checks the user ↔ holder-key binding.
    fn authenticate(
        &self,
        r: &CountersignRequest,
        now_s: i64,
        cart_hash: &[u8; 32],
    ) -> Result<Authenticated, EngineError> {
        let issuer = self.issuer.as_ref().ok_or(EngineError::NoRoot)?;
        let user_key = match &self.root {
            Some(root) => jwk_of(&root.user_key(&r.sub)),
            None => r
                .observation
                .as_ref()
                .ok_or(bad("observation"))?
                .user_key
                .clone(),
        };
        // The open mandate's `nonce` is its `mid`, which is known only once it verifies: verify
        // with the signed nonce, then require it to be the `mid`.
        let nonce = open_mandate_nonce(&r.closed_mandate).ok_or(auth("open_mandate"))?;
        let opts = ClosedMandateVerifyOptions {
            open: OpenMandateVerifyOptions {
                expected_aud: OPEN_MANDATE_AUD.into(),
                expected_nonce: nonce.clone(),
                now: now_s,
                max_skew_sec: MAX_SKEW_SEC,
            },
            request_id: r.request_id.to_string(),
            cart_hash: sha256_tag(cart_hash),
        };
        let closed =
            verify_closed_mandate(&r.closed_mandate, issuer, &opts).map_err(|e| match e {
                keelson_mandate::Error::Credential(code) if code.starts_with("closed_") => {
                    EngineError::Auth(code)
                }
                _ => auth("open_mandate"),
            })?;
        let open = closed.open;
        let mut claims = open.claims;
        if claims.get("mid").and_then(Value::as_str) != Some(nonce.as_str()) {
            return Err(auth("open_nonce"));
        }
        // `sub` is withheld from presentations, so the holder key is what ties the user
        // credential to the request's user.
        let holder = open
            .user_credential
            .as_ref()
            .and_then(|l1| Jwk::from_value(&l1.claims["cnf"]["jwk"]).ok());
        if !holder.is_some_and(|h| same_key(&h, &user_key)) {
            return Err(auth("open_holder"));
        }
        claims.remove("cnf");
        let mandate = Value::Object(claims);
        let commitment = commitment(&mandate).ok_or(auth("open_mandate"))?;
        let h = h_sd(&open.payload).map_err(|_| auth("open_mandate"))?;
        let mandate_hash = mandate_challenge(&h, &Fr::from_be_bytes_reduce(&commitment));
        let user_auth = open.user_auth.unwrap_or_default();
        let part = |k: &str| user_auth[k].as_str().unwrap_or_default().to_owned();
        let assertion = keelson_mandate::Assertion {
            authenticator_data: part("authenticatorData"),
            client_data_json: part("clientDataJSON"),
            signature: part("signature"),
        };
        if open.payload.get("embed") != mandate.get("embed") {
            return Err(auth("open_mandate"));
        }
        verify_user_auth(&assertion, &mandate, mandate_hash, &self.config.origin)?;
        Ok(Authenticated {
            mandate,
            mandate_hash,
            commitment,
            user_key,
        })
    }

    /// Checks a user credential from an earlier registration: issued by this engine's issuer,
    /// to `sub`, for `holder` and the mandate's passkey, its credential id and key.
    fn check_user_credential(
        &self,
        l1: &str,
        sub: &str,
        holder: &Jwk,
        cred_id: &str,
        passkey: &Jwk,
    ) -> Result<(), EngineError> {
        let issuer = self.issuer.as_ref().ok_or(EngineError::NoRoot)?;
        let rejected = || auth("open_user_credential");
        let v = verify_credential(l1, USER_CREDENTIAL_TYP, issuer, None).map_err(|_| rejected())?;
        let key = |v: &Value| Jwk::from_value(v).ok();
        let bound = v.claims.get("sub").and_then(Value::as_str) == Some(sub)
            && key(&v.claims["cnf"]["jwk"]).is_some_and(|k| same_key(&k, holder))
            && v.claims["cred"]["id"].as_str() == Some(cred_id)
            && key(&v.claims["cred"]["jwk"]).is_some_and(|k| same_key(&k, passkey));
        bound.then_some(()).ok_or_else(rejected)
    }
}

fn within(s: &str, max: usize, what: &'static str) -> Result<(), EngineError> {
    (s.len() <= max)
        .then_some(())
        .ok_or(EngineError::TooLarge(what))
}

fn check_register(r: &RegisterMandate) -> Result<(), EngineError> {
    within(&r.sub, MAX_SUB, "sub")?;
    if r.disclosures.len() > MAX_DISCLOSURES {
        return Err(EngineError::TooLarge("disclosures"));
    }
    for d in &r.disclosures {
        within(d, MAX_PART, "disclosure")?;
    }
    let a = &r.assertion;
    for part in [&a.authenticator_data, &a.client_data_json, &a.signature] {
        within(part, MAX_PART, "assertion")?;
    }
    if let Some(l1) = &r.user_credential {
        within(l1, MAX_TOKEN, "user_credential")?;
    }
    let payload = serde_json::to_vec(&r.payload_sd).map_err(|_| bad("payload_sd"))?;
    if payload.len() > MAX_PAYLOAD {
        return Err(EngineError::TooLarge("payload_sd"));
    }
    Ok(())
}

fn check_countersign(r: &CountersignRequest) -> Result<(), EngineError> {
    within(&r.closed_mandate, MAX_TOKEN, "closed_mandate")?;
    within(&r.sub, MAX_SUB, "sub")?;
    if let Some(id) = &r.authorization_id {
        within(id, MAX_STRING, "authorization_id")?;
    }
    let cart = &r.cart;
    if cart.lines.len() > MAX_CART_LINES {
        return Err(EngineError::TooLarge("cart.lines"));
    }
    within(&cart.merchant, MAX_STRING, "cart")?;
    within(&cart.currency, MAX_STRING, "cart")?;
    for line in &cart.lines {
        let optional = [&line.size, &line.color].into_iter().flatten();
        for s in [&line.sku, &line.category].into_iter().chain(optional) {
            within(s, MAX_STRING, "cart")?;
        }
    }
    let b = &r.unit.breakdown;
    let amounts = [
        &b.item_total,
        &b.tax_total,
        &b.shipping,
        &b.handling,
        &b.insurance,
        &b.discount,
        &b.shipping_discount,
    ];
    within(&r.unit.currency, MAX_STRING, "unit")?;
    within(&r.unit.value, MAX_STRING, "unit")?;
    for a in amounts.into_iter().flatten() {
        within(&a.currency_code, MAX_STRING, "unit")?;
        within(&a.value, MAX_STRING, "unit")?;
    }
    if r.evidence.len() > MAX_EVIDENCE_FIELDS {
        return Err(EngineError::TooLarge("evidence"));
    }
    for (field, sources) in &r.evidence {
        within(field, MAX_STRING, "evidence")?;
        if sources.len() > MAX_SOURCES {
            return Err(EngineError::TooLarge("evidence"));
        }
        for s in sources {
            within(s, MAX_STRING, "evidence")?;
        }
    }
    if let Some(o) = &r.observation {
        let k = &o.user_key;
        for s in [Some(&k.x), Some(&k.y), k.kid.as_ref()]
            .into_iter()
            .flatten()
        {
            within(s, MAX_STRING, "observation")?;
        }
        let p = &o.paypal;
        let strings = [
            &p.authorization_id,
            &p.order_id,
            &p.status,
            &p.currency,
            &p.payee_merchant_id,
            &p.custom_id,
        ];
        if strings.iter().any(|s| s.len() > MAX_STRING)
            || p.raw_authorization.0.len() > MAX_TOKEN
            || p.raw_order.0.len() > MAX_TOKEN
        {
            return Err(EngineError::TooLarge("observation"));
        }
    }
    Ok(())
}

/// Binds the mandate `mid` to the first PayPal order that holds its funds, in a sealed record.
/// Every authorization of that order, a reauthorization included, holds the mandate; an
/// authorization of any other order is a [`PayPalDeny::HoldMismatch`].
fn bind_hold(
    root: &Root,
    users: &dyn UserRecords,
    mid: &str,
    order_id: &str,
) -> Result<(), PayPalDeny> {
    let aad = SealAad {
        purpose: MANDATE_HOLD_PURPOSE,
        sub: None,
        record: mid.as_bytes(),
    };
    let key = format!("hold-order\0{mid}");
    let holds = |blob: Vec<u8>| {
        root.unseal(&aad, &blob)
            .is_ok_and(|bound| bound == order_id.as_bytes())
    };
    let bound = match users.get(&key) {
        Some(blob) => holds(blob),
        None => {
            users.insert_new(&key, root.seal(&aad, order_id.as_bytes()))
                || users.get(&key).is_some_and(holds)
        }
    };
    bound.then_some(()).ok_or(PayPalDeny::HoldMismatch)
}

/// Verifies the passkey assertion over `M` against the mandate's `user.cred`, on the RP ID
/// every Keelson passkey is scoped to. A mandate with `embed` was signed in Keelson's approval
/// framed by `embed.top_origin`; any other on `origin`, at the top level.
fn verify_user_auth(
    a: &keelson_mandate::Assertion,
    m: &Value,
    challenge: [u8; 32],
    origin: &str,
) -> Result<(), EngineError> {
    let cred = &m["user"]["cred"];
    if cred["rp_id"] != RP_ID {
        return Err(auth("webauthn_rp_id"));
    }
    let (origin, top_origin) = match m.get("embed") {
        None => (origin, None),
        Some(embed) => {
            let top = embed["top_origin"].as_str().ok_or_else(|| bad("mandate"))?;
            (EMBED_ORIGIN, Some(top.to_owned()))
        }
    };
    let expected = Expected {
        challenge,
        origin: origin.into(),
        top_origin,
        rp_id: RP_ID.into(),
        public_key_sec1: sec1(&cred["jwk"]),
        spc: spc_details(m).map_err(|_| bad("mandate"))?,
    };
    verify_assertion(a, &expected).map_err(|e| auth(&format!("webauthn_{}", webauthn_code(e))))
}

fn webauthn_code(e: WebAuthnError) -> &'static str {
    match e {
        WebAuthnError::ClientData => "client_data",
        WebAuthnError::Type => "type",
        WebAuthnError::Challenge => "challenge",
        WebAuthnError::Origin => "origin",
        WebAuthnError::CrossOrigin => "cross_origin",
        WebAuthnError::TokenBinding => "token_binding",
        WebAuthnError::Payment(_) => "payment",
        WebAuthnError::AuthenticatorData => "authenticator_data",
        WebAuthnError::RpId => "rp_id",
        WebAuthnError::UserPresent => "user_present",
        WebAuthnError::UserVerified => "user_verified",
        WebAuthnError::BackupState => "backup_state",
        WebAuthnError::PublicKey => "public_key",
        WebAuthnError::Signature => "signature",
    }
}

/// `0x04 ‖ x ‖ y` of a JWK, or nothing when a coordinate does not decode.
fn sec1(jwk: &Value) -> Vec<u8> {
    let coordinate = |k: &str| jwk[k].as_str().and_then(|c| URL_SAFE_NO_PAD.decode(c).ok());
    match (coordinate("x"), coordinate("y")) {
        (Some(x), Some(y)) => [&[0x04][..], &x, &y].concat(),
        _ => Vec::new(),
    }
}

/// The signed `nonce` of the open mandate's key binding JWT, read without verifying it.
fn open_mandate_nonce(token: &str) -> Option<String> {
    let kb_jwt = token.split_once("~~")?.1.split('~').next()?;
    let payload = URL_SAFE_NO_PAD.decode(kb_jwt.split('.').nth(1)?).ok()?;
    let payload: Value = serde_json::from_slice(&payload).ok()?;
    payload.get("nonce")?.as_str().map(str::to_owned)
}

/// `zk.commitment` as 32 bytes.
fn commitment(m: &Value) -> Option<[u8; 32]> {
    wire::parse_hex(m["zk"]["commitment"].as_str()?)
}

fn field_bytes(f: &Fr) -> [u8; 32] {
    f.to_be_bytes()
        .try_into()
        .expect("a BN254 element is 32 bytes")
}

fn constraint<'a>(m: &'a Value, section: &str, ty: &str) -> &'a Value {
    m[section]["constraints"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|c| c["type"] == ty)
        .unwrap_or(&Value::Null)
}

/// SHA-256 of the whole request as JSON: everything that decides the countersign or is signed
/// in it, the clock aside. The serialization of the typed request is deterministic.
fn request_digest(r: &CountersignRequest) -> Result<[u8; 32], EngineError> {
    let json = serde_json::to_vec(r).map_err(|_| bad("request"))?;
    Ok(Sha256::new()
        .chain_update(b"keelson/countersign-request/v1\0")
        .chain_update(json)
        .finalize()
        .into())
}

/// `sha256:<hex>`.
/// The `Countersign` its JSON form names.
fn countersign_of(j: &CountersignJson) -> Result<Countersign, EngineError> {
    fn num<T: std::str::FromStr>(s: &str) -> Result<T, EngineError> {
        s.parse().map_err(|_| bad("countersign"))
    }
    let issued: u64 = num(&j.issued_at)?;
    let expires: u64 = num(&j.expires_at)?;
    Ok(Countersign {
        requestId: B256::new(j.request_id.0),
        mandateHash: B256::new(j.mandate_hash.0),
        mandateCommitment: B256::new(j.mandate_commitment.0),
        cartHash: B256::new(j.cart_hash.0),
        agentId: U256::from_str_radix(&j.agent_id, 10).map_err(|_| bad("countersign"))?,
        merchantId: B256::new(j.merchant_id.0),
        amount: num(&j.amount)?,
        currency: num(&j.currency)?,
        category: num(&j.category)?,
        evidenceRoot: B256::new(j.evidence_root.0),
        evalHash: B256::new(j.eval_hash.0),
        policySetHash: B256::new(j.policy_set_hash.0),
        decision: num(&j.decision)?,
        failedFieldsMask: num(&j.failed_fields_mask)?,
        issuedAt: U40::try_from(issued).map_err(|_| bad("countersign"))?,
        expiresAt: U40::try_from(expires).map_err(|_| bad("countersign"))?,
    })
}

fn sha256_tag(digest: &[u8; 32]) -> String {
    let hex = Hex(*digest).to_string();
    format!("sha256:{}", &hex[2..])
}

fn jwk_of(key: &SigningKey) -> Jwk {
    Jwk::from_verifying_key(key.verifying_key())
}

fn same_key(a: &Jwk, b: &Jwk) -> bool {
    (&a.x, &a.y) == (&b.x, &b.y)
}

pub(crate) fn unix_ms(t: OffsetDateTime) -> Option<i64> {
    i64::try_from(t.unix_timestamp_nanos().div_euclid(1_000_000)).ok()
}

fn uint40(seconds: i64) -> Result<U40, EngineError> {
    u64::try_from(seconds)
        .ok()
        .and_then(|s| U40::try_from(s).ok())
        .ok_or(bad("clock"))
}

fn random_salt() -> [u8; 16] {
    let mut salt = [0; 16];
    getrandom::fill(&mut salt).expect("the OS RNG is available");
    salt
}
