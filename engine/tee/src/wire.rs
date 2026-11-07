//! The engine's requests and responses, as they cross between the legs and the API.
//!
//! Byte strings are `0x`-prefixed lowercase hex ([`Hex`]) or standard padded base64 ([`Base64`]);
//! `Countersign` numbers are decimal strings, as viem writes typed-data messages.

use std::collections::BTreeMap;
use std::fmt;

use alloy_primitives::Address;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use keelson_canon::{Cart, PayPalUnit};
use keelson_core::eip712::Countersign;
use keelson_mandate::Jwk;
use keelson_policy::FieldId;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};
use ulid::Ulid;

use crate::TeeKind;

/// `N` bytes as `0x`-prefixed lowercase hex.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hex<const N: usize>(pub [u8; N]);

pub type Hex32 = Hex<32>;
pub type Hex65 = Hex<65>;

impl<const N: usize> fmt::Display for Hex<N> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("0x")?;
        self.0.iter().try_for_each(|b| write!(f, "{b:02x}"))
    }
}

impl<const N: usize> Serialize for Hex<N> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de, const N: usize> Deserialize<'de> for Hex<N> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        parse_hex(&s)
            .map(Self)
            .ok_or_else(|| D::Error::custom(format!("expected 0x and {N} bytes of lowercase hex")))
    }
}

pub(crate) fn parse_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    let digits = s.strip_prefix("0x")?.as_bytes();
    if digits.len() != 2 * N {
        return None;
    }
    let nibble = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let mut out = [0; N];
    for (byte, [hi, lo]) in out.iter_mut().zip(digits.as_chunks::<2>().0) {
        *byte = nibble(*hi)? << 4 | nibble(*lo)?;
    }
    Some(out)
}

/// Bytes as standard padded base64 (RFC 4648 section 4).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Base64(pub Vec<u8>);

impl Serialize for Base64 {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(&self.0))
    }
}

impl<'de> Deserialize<'de> for Base64 {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        STANDARD.decode(s).map(Self).map_err(D::Error::custom)
    }
}

/// A P-256 public JWK, `{ "kty", "crv", "x", "y" }` and an optional `kid`.
mod jwk {
    use super::*;

    pub fn serialize<S: Serializer>(k: &Jwk, s: S) -> Result<S::Ok, S::Error> {
        let mut v = json!({ "kty": "EC", "crv": "P-256", "x": k.x, "y": k.y });
        if let Some(kid) = &k.kid {
            v["kid"] = json!(kid);
        }
        v.serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Jwk, D::Error> {
        Jwk::from_value(&Value::deserialize(d)?).map_err(D::Error::custom)
    }
}

/// A passkey assertion as the browser returns it, every field base64url without padding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Assertion {
    #[serde(rename = "authenticatorData")]
    pub authenticator_data: String,
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    pub signature: String,
}

impl From<&Assertion> for keelson_mandate::Assertion {
    fn from(a: &Assertion) -> Self {
        Self {
            authenticator_data: a.authenticator_data.clone(),
            client_data_json: a.client_data_json.clone(),
            signature: a.signature.clone(),
        }
    }
}

/// A mandate the user signed with their passkey, to be issued as an open mandate.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterMandate {
    /// The authenticated user; must be the mandate's `user.sub`.
    pub sub: String,
    pub payload_sd: Value,
    pub disclosures: Vec<String>,
    /// The passkey assertion over `M`, made on the engine's configured origin.
    pub assertion: Assertion,
    /// The salt that opens `zk.commitment`.
    #[serde(with = "hex_array")]
    pub salt: [u8; 16],
    /// The user's credential from an earlier registration; a new one is issued when absent.
    pub user_credential: Option<String>,
}

mod hex_array {
    use super::*;

    pub fn serialize<S: Serializer>(b: &[u8; 16], s: S) -> Result<S::Ok, S::Error> {
        Hex(*b).serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 16], D::Error> {
        Hex::<16>::deserialize(d).map(|h| h.0)
    }
}

/// The credentials issued for a registered mandate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MandateIssued {
    /// The mandate challenge `M`.
    pub mandate_hash: Hex32,
    /// The user credential (L1), an SD-JWT VC with its disclosures.
    pub user_credential: String,
    /// The open mandate (L2) the agent closes per purchase.
    pub open_mandate: String,
    /// The commitment salt, sealed to the user and `M`.
    pub sealed_salt: Base64,
}

/// What PayPal reported about an authorization and its order, read by the engine itself.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PayPalObservation {
    pub authorization_id: String,
    /// The authorization status, e.g. `CREATED` or `PARTIALLY_CAPTURED`.
    pub status: String,
    pub currency: String,
    pub authorized_minor: i64,
    /// The sum of the order's `COMPLETED` and `PENDING` captures of this authorization.
    pub captured_minor: i64,
    pub payee_merchant_id: String,
    /// The authorization's `expiration_time`, in Unix milliseconds.
    pub expires_at_ms: i64,
    /// The authorization's `custom_id`, which names the mandate it holds funds for.
    pub custom_id: String,
    /// The authorization response body as PayPal sent it.
    pub raw_authorization: Base64,
    /// The order response body as PayPal sent it.
    pub raw_order: Base64,
    /// The engine's clock when the reads finished, in Unix milliseconds.
    pub read_at_ms: i64,
}

/// The facts the leg holding the KMS root (leg A) observed, which the other leg (leg B) signs
/// over as given.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    /// Leg A's clock, in Unix milliseconds.
    pub now_ms: i64,
    pub budget_left_minor: i64,
    /// The holder key of the request's user, `user_key(sub)`.
    #[serde(with = "jwk")]
    pub user_key: Jwk,
    pub paypal: PayPalObservation,
}

/// A cart the agent asks the engine to countersign.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CountersignRequest {
    pub request_id: Ulid,
    /// The open mandate closed by the agent's KB-JWT over `request_id` and the cart.
    pub closed_mandate: String,
    pub sub: String,
    pub cart: Cart,
    pub unit: PayPalUnit,
    /// The evidence source of each field. `ucp:` and `zktls:` sources are refused: only the
    /// engine's own verifiers may supply them.
    pub evidence: BTreeMap<FieldId, Vec<String>>,
    pub evidence_root: Hex32,
    /// The PayPal authorization holding the mandate's funds. Leg A reads it; leg B takes the
    /// reading from `observation`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_id: Option<String>,
    /// Present on leg B, from leg A.
    pub observation: Option<Observation>,
}

/// A `Countersign` message in the JSON form of viem typed data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CountersignJson {
    pub request_id: Hex32,
    pub mandate_hash: Hex32,
    pub mandate_commitment: Hex32,
    pub cart_hash: Hex32,
    pub agent_id: String,
    pub merchant_id: Hex32,
    pub amount: String,
    pub currency: String,
    pub category: String,
    pub evidence_root: Hex32,
    pub eval_hash: Hex32,
    pub policy_set_hash: Hex32,
    pub decision: String,
    pub failed_fields_mask: String,
    pub issued_at: String,
    pub expires_at: String,
}

impl From<&Countersign> for CountersignJson {
    fn from(c: &Countersign) -> Self {
        Self {
            request_id: Hex(c.requestId.0),
            mandate_hash: Hex(c.mandateHash.0),
            mandate_commitment: Hex(c.mandateCommitment.0),
            cart_hash: Hex(c.cartHash.0),
            agent_id: c.agentId.to_string(),
            merchant_id: Hex(c.merchantId.0),
            amount: c.amount.to_string(),
            currency: c.currency.to_string(),
            category: c.category.to_string(),
            evidence_root: Hex(c.evidenceRoot.0),
            eval_hash: Hex(c.evalHash.0),
            policy_set_hash: Hex(c.policySetHash.0),
            decision: c.decision.to_string(),
            failed_fields_mask: c.failedFieldsMask.to_string(),
            issued_at: c.issuedAt.to_string(),
            expires_at: c.expiresAt.to_string(),
        }
    }
}

/// A signed `Countersign` and what it was computed from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Countersigned {
    pub countersign: CountersignJson,
    /// The EIP-712 signing hash.
    pub digest: Hex32,
    /// `r ‖ s ‖ v`.
    pub signature: Hex65,
    pub signer: Address,
    pub tee: TeeKind,
    /// The `keelson.eval/1` trace as RFC 8785 JSON; `evalHash` commits to these bytes.
    pub trace_jcs: Base64,
    /// The facts the decision used, for leg B.
    pub observation: Observation,
}
