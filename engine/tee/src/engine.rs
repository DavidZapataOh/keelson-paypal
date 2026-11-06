//! The engine: registers mandates and countersigns carts.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};

use alloy_primitives::aliases::U40;
use alloy_primitives::{Address, B256, U256};
use alloy_sol_types::Eip712Domain;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use keelson_canon::{Cart, Deny, canonicalize, cart_hash};
use keelson_core::eip712::Countersign;
use keelson_core::{AcirField, Dst, currency_numeric};
use keelson_mandate::{
    CATEGORY_IDS, ClosedMandateVerifyOptions, Expected, Fr, Jwk, OpenMandateParams,
    OpenMandateVerifyOptions, PasskeyCredential, RP_ID, USER_CREDENTIAL_TYP, UserAuth,
    UserCredentialParams, WebAuthnError, decode_mandate, h_sd, issue_open_mandate,
    issue_user_credential, mandate_challenge, mandate_commitment, merchant_leaf, spc_details,
    verify_assertion, verify_closed_mandate, verify_credential,
};
use keelson_policy::{
    Decision, EngineMeta, EvalInput, TRACE_VERSION, Trace, agent_uid, evaluate, policy_set_hash,
    policy_set_hash_tag, schema_hash_tag, trace_jcs,
};
use p256::ecdsa::SigningKey;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::macros::format_description;
use time::{Duration, OffsetDateTime, UtcOffset};
use ulid::Ulid;

use crate::budget::Budget;
use crate::wire::{
    self, Base64, CountersignRequest, Countersigned, Hex, MandateIssued, Observation,
    RegisterMandate,
};
use crate::{Error, Root, SealAad, Signer, TeeKind, countersign_digest, failed_fields_mask};

/// The seal purpose of a mandate's commitment salt; the record is `M`.
pub const MANDATE_SALT_PURPOSE: &str = "keelson/seal/mandate-salt/v1";
/// The seal purpose of a user's record, which binds their `sub` to their passkey.
pub const USER_PASSKEY_PURPOSE: &str = "keelson/seal/user-passkey/v1";
const USER_PASSKEY_RECORD: &[u8] = b"passkey";

/// `iss` of the user credential.
const ISSUER: &str = "https://keelson.finance";
/// `aud` of the open mandate; its `nonce` is the mandate `mid`.
const OPEN_MANDATE_AUD: &str = "keelson.finance";
/// Lifetime of a countersign, and how long after boot nothing is allowed.
const COUNTERSIGN_TTL: i64 = 900;
/// Clock skew tolerated on credential and key-binding times.
const MAX_SKEW_SEC: i64 = 60;
/// How far leg A's clock may be from this leg's.
const MAX_OBSERVATION_SKEW_MS: u64 = 2_000;
/// `category` of a cart with no single category in `CATEGORY_IDS`.
const NO_CATEGORY: u8 = 255;

/// Boot configuration, bound into the attestation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineConfig {
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
    /// Minor units captured against the mandate whose challenge is `mandate_hash`, or `None`
    /// while it has not been read, which refuses the countersign.
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
    /// A leg A input is missing: the captured amount or the user records.
    NotReady,
    /// The request id was already countersigned for another cart.
    Replay,
    /// The signer could not sign; see [`Error`].
    Signer(Error),
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
            Self::NotReady => "not_ready".into(),
            Self::Replay => "replay".into(),
            Self::Signer(_) => "signer".into(),
        }
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadRequest(what) => write!(f, "bad_request: {what}"),
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
    issuer: Option<Jwk>,
    meta: EngineMeta,
    domain: Eip712Domain,
    captured: Option<Arc<dyn CapturedSource>>,
    users: Option<Arc<dyn UserRecords>>,
    answered: Mutex<BTreeMap<([u8; 32], Ulid), Answered>>,
}

/// A countersign already given for a request, kept until it expires.
#[derive(Clone)]
struct Answered {
    cart_hash: [u8; 32],
    expires_at: i64,
    out: Countersigned,
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
        let domain = keelson_core::domain(config.chain_id, config.verifying_contract)
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
            issuer,
            domain,
            captured: None,
            users: None,
            answered: Mutex::default(),
        }
    }

    /// Sets the captured amounts leg A counts against each budget.
    pub fn with_captured(mut self, captured: Arc<dyn CapturedSource>) -> Self {
        self.captured = Some(captured);
        self
    }

    /// Sets where leg A keeps the sealed user records.
    pub fn with_user_records(mut self, users: Arc<dyn UserRecords>) -> Self {
        self.users = Some(users);
        self
    }

    /// The countersign signer's address.
    pub fn signer(&self) -> Address {
        self.signer.address()
    }

    /// Verifies the passkey assertion over a mandate and issues its open mandate, and the user
    /// credential when the request has none.
    pub fn register_mandate(
        &self,
        r: &RegisterMandate,
        now: OffsetDateTime,
    ) -> Result<MandateIssued, EngineError> {
        let root = self.root.as_ref().ok_or(EngineError::NoRoot)?;
        let users = self.users.as_ref().ok_or(EngineError::NotReady)?;
        let m = decode_mandate(&r.payload_sd, &r.disclosures).map_err(|_| bad("mandate"))?;
        if m["user"]["sub"] != r.sub.as_str() {
            return Err(bad("sub"));
        }
        let cm = mandate_commitment(&m, r.salt).map_err(|_| bad("mandate"))?;
        if Some(field_bytes(&cm)) != commitment(&m) {
            return Err(EngineError::CommitmentMismatch);
        }
        let h = h_sd(&r.payload_sd).map_err(|_| bad("mandate"))?;
        let mandate_hash = mandate_challenge(&h, &cm);
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
            self.check_user_credential(l1, &r.sub, &jwk_of(&holder), &passkey)?;
        }
        bind_passkey(
            root,
            users.as_ref(),
            &r.sub,
            &passkey,
            r.user_credential.is_some(),
        )?;
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
    /// same request with the same cart gets the same countersign, another cart is a replay.
    pub fn countersign(
        &self,
        r: &CountersignRequest,
        clock_now: OffsetDateTime,
    ) -> Result<Countersigned, EngineError> {
        let captured = match (&self.root, &r.observation) {
            (Some(_), Some(_)) | (None, None) => return Err(bad("observation")),
            (Some(_), None) => Some(self.captured.as_ref().ok_or(EngineError::NotReady)?),
            (None, Some(_)) => None,
        };
        let clock_ms = unix_ms(clock_now).ok_or(bad("clock"))?;
        let now_ms = match &r.observation {
            Some(o) if o.now_ms.abs_diff(clock_ms) > MAX_OBSERVATION_SKEW_MS => {
                return Err(EngineError::Clock);
            }
            Some(o) => o.now_ms,
            None => clock_ms,
        };
        let now = OffsetDateTime::from_unix_timestamp_nanos(i128::from(now_ms) * 1_000_000)
            .map_err(|_| bad("clock"))?;
        let now_s = now_ms.div_euclid(1000);
        let forged = |e: &String| e.starts_with("ucp:") || e.starts_with("zktls:");
        if r.evidence.values().flatten().any(forged) {
            return Err(bad("evidence"));
        }
        let cart_hash = cart_hash(&r.cart).map_err(|_| bad("cart"))?;
        let a = self.authenticate(r, now_s, &cart_hash)?;
        let key = (a.mandate_hash, r.request_id);
        if let Some(done) = self.answered(&key, now_s) {
            return (done.cart_hash == cart_hash)
                .then_some(done.out)
                .ok_or(EngineError::Replay);
        }

        // Everything that can fail is read before any budget is reserved.
        let m = &a.mandate;
        let exp = m["exp"].as_i64().ok_or(bad("mandate"))?;
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
        let expires_at = now_s.saturating_add(COUNTERSIGN_TTL).min(exp);
        let until = OffsetDateTime::from_unix_timestamp(expires_at).map_err(|_| bad("clock"))?;
        let (issued_at, expires) = (uint40(now_s)?, uint40(expires_at)?);
        let context = canonicalize(&r.cart, &r.unit);
        let total = context.as_ref().map_or(0, |c| c.total_minor);
        let amount = u64::try_from(total).map_err(|_| bad("cart"))?;
        let captured = match captured {
            Some(source) => source
                .captured_minor(&a.mandate_hash)
                .ok_or(EngineError::NotReady)?,
            None => 0,
        };
        let warming_up = clock_now < self.boot + Duration::seconds(COUNTERSIGN_TTL);

        let out = loop {
            let budget_left = match &r.observation {
                Some(o) => o.budget_left_minor,
                None if warming_up => 0,
                None => self.budget.left(&a.mandate_hash, budget_max, captured, now),
            };
            let (trace, canon) = match &context {
                Ok(context) => {
                    let input = EvalInput {
                        mandate: m.clone(),
                        budget_left_minor: budget_left,
                        // The KB-JWT signer is the mandate's `cnf`, so the mandate's agent is
                        // the authenticated requester.
                        agent: agent.clone(),
                        context: context.clone(),
                        now,
                        evidence: r.evidence.clone(),
                        mandate_hash: a.mandate_hash,
                        cart_hash,
                    };
                    (evaluate(&input, &self.meta), None)
                }
                Err(deny) => (
                    self.canon_trace(*deny, now, &a.mandate_hash, &cart_hash),
                    Some(*deny),
                ),
            };
            let jcs = trace_jcs(&trace);
            let eval_hash: [u8; 32] = Sha256::new()
                .chain_update(Dst::Eval.as_str())
                .chain_update([0])
                .chain_update(&jcs)
                .finalize()
                .into();
            let allow = trace.decision == Decision::Allow;
            let cedar_errors = canon.is_none() && !trace.errors.is_empty();
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
                    false,
                ),
                issuedAt: issued_at,
                expiresAt: expires,
            };
            let signature = self
                .signer
                .sign_countersign(&c, &self.domain)
                .map_err(EngineError::Signer)?;
            // Reserving is the last step, so no failure can leave a reservation behind. If a
            // concurrent request reserved since `left`, evaluate again.
            if allow
                && r.observation.is_none()
                && !self.budget.reserve(
                    &a.mandate_hash,
                    r.request_id,
                    budget_max,
                    captured,
                    total,
                    now,
                    until,
                )
            {
                continue;
            }
            break Countersigned {
                countersign: (&c).into(),
                digest: Hex(countersign_digest(&c, &self.domain)),
                signature: Hex(signature),
                signer: self.signer.address(),
                tee: self.config.tee_kind,
                trace_jcs: Base64(jcs),
                observation: Observation {
                    now_ms,
                    budget_left_minor: budget_left,
                    user_key: a.user_key.clone(),
                    paypal: r
                        .observation
                        .as_ref()
                        .map(|o| o.paypal.clone())
                        .unwrap_or_default(),
                },
            };
        };
        self.remember(key, cart_hash, expires_at, out)
    }

    /// The countersign already given for `key`, dropping those expired at `now_s`.
    fn answered(&self, key: &([u8; 32], Ulid), now_s: i64) -> Option<Answered> {
        let mut answered = self.answered.lock().unwrap_or_else(PoisonError::into_inner);
        answered.retain(|_, a| a.expires_at > now_s);
        answered.get(key).cloned()
    }

    /// Records `out` as the answer to `key`. A concurrent request with the same id answered
    /// first keeps its answer, and a different cart under it is a replay.
    fn remember(
        &self,
        key: ([u8; 32], Ulid),
        cart_hash: [u8; 32],
        expires_at: i64,
        out: Countersigned,
    ) -> Result<Countersigned, EngineError> {
        let mut answered = self.answered.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = answered.entry(key).or_insert(Answered {
            cart_hash,
            expires_at,
            out,
        });
        (entry.cart_hash == cart_hash)
            .then(|| entry.out.clone())
            .ok_or(EngineError::Replay)
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
        verify_user_auth(&assertion, &mandate, mandate_hash, &self.config.origin)?;
        Ok(Authenticated {
            mandate,
            mandate_hash,
            commitment,
            user_key,
        })
    }

    /// Checks a user credential from an earlier registration: issued by this engine's issuer,
    /// to `sub`, for `holder` and the mandate's passkey.
    fn check_user_credential(
        &self,
        l1: &str,
        sub: &str,
        holder: &Jwk,
        passkey: &Jwk,
    ) -> Result<(), EngineError> {
        let issuer = self.issuer.as_ref().ok_or(EngineError::NoRoot)?;
        let rejected = || auth("open_user_credential");
        let v = verify_credential(l1, USER_CREDENTIAL_TYP, issuer, None).map_err(|_| rejected())?;
        let key = |v: &Value| Jwk::from_value(v).ok();
        let bound = v.claims.get("sub").and_then(Value::as_str) == Some(sub)
            && key(&v.claims["cnf"]["jwk"]).is_some_and(|k| same_key(&k, holder))
            && key(&v.claims["cred"]["jwk"]).is_some_and(|k| same_key(&k, passkey));
        bound.then_some(()).ok_or_else(rejected)
    }

    /// The trace of a cart the canonicalizer denied: no context and no policy ran.
    fn canon_trace(
        &self,
        deny: Deny,
        now: OffsetDateTime,
        mandate_hash: &[u8; 32],
        cart_hash: &[u8; 32],
    ) -> Trace {
        let reason = serde_json::to_value(deny).expect("Deny serializes to a string");
        let meta = &self.meta;
        Trace {
            v: TRACE_VERSION.into(),
            engine: keelson_policy::Engine {
                cedar_policy: meta.cedar_policy.clone(),
                lang: meta.lang.clone(),
                symcc: meta.symcc.clone(),
                cvc5: meta.cvc5.clone(),
                oci_digest: meta.oci_digest.clone(),
                canonicalizer: meta.canonicalizer.clone(),
            },
            policy_set_hash: policy_set_hash_tag(),
            schema_hash: schema_hash_tag(),
            proof_bundle_hash: meta.proof_bundle_hash.clone(),
            extras_hash: None,
            mandate_hash: Hex(*mandate_hash).to_string(),
            cart_hash: sha256_tag(cart_hash),
            context: json!({}),
            decision: Decision::Deny,
            fired: Vec::new(),
            fields: Vec::new(),
            errors: vec![format!("canon.{}", reason.as_str().unwrap_or_default())],
            t_tee: now
                .to_offset(UtcOffset::UTC)
                .format(format_description!(
                    "[year]-[month]-[day]T[hour]:[minute]:[second]Z"
                ))
                .unwrap_or_default(),
        }
    }
}

/// Binds `sub` to `passkey` on its first registration, in a record sealed to `sub`. Later
/// registrations must use that passkey, unless they present a user credential issued for `sub`
/// and this passkey (`vouched`).
fn bind_passkey(
    root: &Root,
    users: &dyn UserRecords,
    sub: &str,
    passkey: &Jwk,
    vouched: bool,
) -> Result<(), EngineError> {
    let aad = SealAad {
        purpose: USER_PASSKEY_PURPOSE,
        sub: Some(sub),
        record: USER_PASSKEY_RECORD,
    };
    let key = sec1(&json!({ "x": passkey.x, "y": passkey.y }));
    let holds = |blob: Vec<u8>| root.unseal(&aad, &blob).is_ok_and(|bound| bound == key);
    let bound = match users.get(sub) {
        Some(blob) => vouched || holds(blob),
        None => users.insert_new(sub, root.seal(&aad, &key)) || users.get(sub).is_some_and(holds),
    };
    bound.then_some(()).ok_or_else(|| auth("sub_bound"))
}

/// Verifies the passkey assertion over `M` against the mandate's `user.cred`, on the RP ID
/// every Keelson passkey is scoped to.
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
    let expected = Expected {
        challenge,
        origin: origin.into(),
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

/// The bit index in `CATEGORY_IDS` of the cart's only category, or 255.
fn category(cart: &Cart) -> u8 {
    let ids: BTreeSet<&str> = cart.lines.iter().map(|l| l.category.as_str()).collect();
    match ids.into_iter().collect::<Vec<_>>()[..] {
        [id] => CATEGORY_IDS
            .iter()
            .position(|c| *c == id)
            .and_then(|i| u8::try_from(i).ok())
            .unwrap_or(NO_CATEGORY),
        _ => NO_CATEGORY,
    }
}

/// `sha256:<hex>`.
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

fn unix_ms(t: OffsetDateTime) -> Option<i64> {
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
