//! The v2 Alibi leaf: a SCITT signed statement (RFC 9943), a `COSE_Sign1` with ES256K whose
//! payload is the countersigned facts in deterministic CBOR (RFC 8949 §4.2.1).

use ciborium::value::{CanonicalValue, Integer, Value};

use crate::eip712::Countersign;

/// The content type of a purchase statement's payload.
pub const CLAIMS_CONTENT_TYPE: &str = "application/vnd.keelson.alibi-claims+cbor";
/// The issuer every Alibi statement names in its CWT claims.
pub const STATEMENT_ISSUER: &str = "https://keelson.finance";
/// COSE algorithm ES256K (RFC 8812).
pub const ALG_ES256K: i64 = -47;
const COSE_SIGN1_TAG: u64 = 18;

/// `2of2` when both legs signed, `Degraded` when only the TDX leg did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    TwoOfTwo,
    Degraded,
}

/// One leg's EIP-712 signature as the statement carries it. `kind` is 1 (TDX) or 2 (Nitro).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegSignature {
    pub kind: u8,
    pub signer: [u8; 20],
    pub signature: [u8; 65],
    pub measurement: [u8; 32],
}

/// What a purchase statement asserts.
#[derive(Clone, Copy)]
pub struct StatementClaims<'a> {
    pub countersign: &'a Countersign,
    pub chain_id: u64,
    pub verifying_contract: [u8; 20],
    pub mode: Mode,
    /// `[tdx]` when degraded, `[tdx, nitro]` for 2of2.
    pub legs: &'a [LegSignature],
    /// The payment reference commitment (PayPal rail).
    pub pay_ref: Option<[u8; 32]>,
}

fn int(n: impl Into<Integer>) -> Value {
    Value::Integer(n.into())
}

fn bytes(b: &[u8]) -> Value {
    Value::Bytes(b.to_vec())
}

/// A uint256 in its preferred CBOR form: an integer up to `u64::MAX`, tag 2 above it.
fn uint256(n: alloy_primitives::U256) -> Value {
    match u64::try_from(n) {
        Ok(v) => int(v),
        Err(_) => {
            let be = n.to_be_bytes_trimmed_vec();
            Value::Tag(2, Box::new(Value::Bytes(be)))
        }
    }
}

/// Encodes a value in RFC 8949 §4.2.1 core deterministic form: maps sorted by encoded key.
fn encode(value: Value) -> Vec<u8> {
    let mut out = Vec::new();
    ciborium::into_writer(&canonical(value), &mut out).expect("CBOR into a Vec never fails");
    out
}

fn canonical(value: Value) -> Value {
    match value {
        Value::Map(entries) => {
            let mut sorted: Vec<(CanonicalValue, Value)> = entries
                .into_iter()
                .map(|(k, v)| (CanonicalValue::from(canonical(k)), canonical(v)))
                .collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Map(
                sorted
                    .into_iter()
                    .map(|(k, v)| (Value::from(k), v))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.into_iter().map(canonical).collect()),
        Value::Tag(t, inner) => Value::Tag(t, Box::new(canonical(*inner))),
        other => other,
    }
}

fn signed_entries(
    chain_id: u64,
    verifying_contract: [u8; 20],
    mode: Mode,
    legs: &[LegSignature],
) -> Vec<(Value, Value)> {
    vec![
        (int(18), int(chain_id)),
        (int(19), bytes(&verifying_contract)),
        (
            int(20),
            int(match mode {
                Mode::TwoOfTwo => 1u8,
                Mode::Degraded => 2u8,
            }),
        ),
        (
            int(21),
            Value::Array(
                legs.iter()
                    .map(|l| {
                        Value::Array(vec![
                            int(l.kind),
                            bytes(&l.signer),
                            bytes(&l.signature),
                            bytes(&l.measurement),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]
}

/// The payload: the claims as an integer-keyed map in deterministic CBOR.
pub fn claims_bytes(c: &StatementClaims<'_>) -> Vec<u8> {
    let n = c.countersign;
    let mut map = vec![
        (int(1), int(2)),
        (int(2), bytes(n.requestId.as_slice())),
        (int(3), bytes(n.mandateHash.as_slice())),
        (int(4), bytes(n.mandateCommitment.as_slice())),
        (int(5), bytes(n.cartHash.as_slice())),
        (int(6), uint256(n.agentId)),
        (int(7), bytes(n.merchantId.as_slice())),
        (int(8), int(n.amount)),
        (int(9), int(n.currency)),
        (int(10), int(n.category)),
        (int(11), bytes(n.evidenceRoot.as_slice())),
        (int(12), bytes(n.evalHash.as_slice())),
        (int(13), bytes(n.policySetHash.as_slice())),
        (int(14), int(n.decision)),
        (int(15), int(n.failedFieldsMask)),
        (int(16), int(n.issuedAt.to::<u64>())),
        (int(17), int(n.expiresAt.to::<u64>())),
    ];
    map.extend(signed_entries(
        c.chain_id,
        c.verifying_contract,
        c.mode,
        c.legs,
    ));
    if let Some(r) = c.pay_ref {
        map.push((int(22), bytes(&r)));
    }
    encode(Value::Map(map))
}

/// The protected header: ES256K, the content type, the signer as `kid`, and CWT claims
/// `{iss, sub, iat}` (RFC 9597).
pub fn protected_header(
    signer: [u8; 20],
    alibi_id: &str,
    issued_at: u64,
    content_type: &str,
) -> Vec<u8> {
    encode(Value::Map(vec![
        (int(1), int(ALG_ES256K)),
        (int(3), Value::Text(content_type.into())),
        (int(4), bytes(&signer)),
        (
            int(15),
            Value::Map(vec![
                (int(1), Value::Text(STATEMENT_ISSUER.into())),
                (int(2), Value::Text(alibi_id.into())),
                (int(6), int(issued_at)),
            ]),
        ),
    ]))
}

/// The protected header of a purchase statement.
pub fn statement_protected(signer: [u8; 20], alibi_id: &str, issued_at: u64) -> Vec<u8> {
    protected_header(signer, alibi_id, issued_at, CLAIMS_CONTENT_TYPE)
}

/// `Sig_structure` (RFC 9052 §4.4) with no external AAD.
pub fn to_be_signed(protected: &[u8], payload: &[u8]) -> Vec<u8> {
    encode(Value::Array(vec![
        Value::Text("Signature1".into()),
        bytes(protected),
        bytes(&[]),
        bytes(payload),
    ]))
}

/// The tagged `COSE_Sign1` with an empty unprotected header: the log leaf.
pub fn statement(protected: Vec<u8>, payload: Vec<u8>, signature: [u8; 64]) -> Vec<u8> {
    encode(Value::Tag(
        COSE_SIGN1_TAG,
        Box::new(Value::Array(vec![
            Value::Bytes(protected),
            Value::Map(vec![]),
            Value::Bytes(payload),
            bytes(&signature),
        ])),
    ))
}
