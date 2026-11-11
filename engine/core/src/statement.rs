//! The v2 Alibi leaf: a SCITT signed statement (RFC 9943), a `COSE_Sign1` with ES256K whose
//! payload is the countersigned facts in deterministic CBOR (RFC 8949 §4.2.1).

use ciborium::value::{CanonicalValue, Integer, Value};
use sha2::{Digest, Sha256};

use crate::eip712::{CardAuthorization, CardSettlement, Countersign};

/// The content type of a purchase statement's payload.
pub const CLAIMS_CONTENT_TYPE: &str = "application/vnd.keelson.alibi-claims+cbor";
/// The content type of a card authorization decision's payload.
pub const CARD_AUTHORIZATION_CONTENT_TYPE: &str =
    "application/vnd.keelson.card-authorization-claims+cbor";
/// The content type of a card settlement's payload.
pub const CARD_SETTLEMENT_CONTENT_TYPE: &str =
    "application/vnd.keelson.card-settlement-claims+cbor";
/// The content type of a bridge statement: a v1 Alibi's countersigned facts carried into v2.
pub const BRIDGE_CONTENT_TYPE: &str = "application/vnd.keelson.alibi-bridge-claims+cbor";
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

/// A v1 Alibi's countersigned facts, its own legs and the hash of its v1 leaf; no payment commit.
#[derive(Clone, Copy)]
pub struct BridgeClaims<'a> {
    pub countersign: &'a Countersign,
    pub chain_id: u64,
    pub verifying_contract: [u8; 20],
    pub mode: Mode,
    pub legs: &'a [LegSignature],
    pub predecessor: [u8; 32],
}

/// The payload: the claims as an integer-keyed map in deterministic CBOR.
pub fn claims_bytes(c: &StatementClaims<'_>) -> Vec<u8> {
    let mut map = countersign_entries(c.countersign);
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

/// A bridge statement's payload: the purchase claims without a payment commit, with key 23.
pub fn bridge_claims_bytes(c: &BridgeClaims<'_>) -> Vec<u8> {
    let mut map = countersign_entries(c.countersign);
    map.extend(signed_entries(
        c.chain_id,
        c.verifying_contract,
        c.mode,
        c.legs,
    ));
    map.push((int(23), bytes(&c.predecessor)));
    encode(Value::Map(map))
}

fn countersign_entries(n: &Countersign) -> Vec<(Value, Value)> {
    vec![
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
    ]
}

/// One card network authorization decision, linked to its purchase leaf.
#[derive(Clone, Copy)]
pub struct CardAuthorizationClaims<'a> {
    pub authorization: &'a CardAuthorization,
    /// `cardRefCommit(salt, issuer, card token)`, computed in the leg.
    pub card_ref: [u8; 32],
    /// The purchase leaf's RFC 6962 hash.
    pub parent: [u8; 32],
    pub chain_id: u64,
    pub verifying_contract: [u8; 20],
    pub mode: Mode,
    pub legs: &'a [LegSignature],
}

/// One card settlement as the legs read it from the issuer, linked to its purchase leaf.
#[derive(Clone, Copy)]
pub struct CardSettlementClaims<'a> {
    pub settlement: &'a CardSettlement,
    pub parent: [u8; 32],
    pub chain_id: u64,
    pub verifying_contract: [u8; 20],
    pub mode: Mode,
    pub legs: &'a [LegSignature],
}

/// A card authorization decision's payload.
pub fn card_authorization_claims_bytes(c: &CardAuthorizationClaims<'_>) -> Vec<u8> {
    let a = c.authorization;
    let mut map = vec![
        (int(1), int(2)),
        (int(2), bytes(a.requestId.as_slice())),
        (int(3), bytes(a.countersignDigest.as_slice())),
        (int(4), bytes(a.authorizationHash.as_slice())),
        (int(5), bytes(a.merchantHash.as_slice())),
        (int(6), int(a.mcc)),
        (int(7), bytes(a.country.as_slice())),
        (int(8), int(a.amount)),
        (int(9), int(a.currency)),
        (int(10), int(a.decision)),
        (int(11), int(a.failedMask)),
        (int(12), int(a.issuedAt.to::<u64>())),
        (int(13), bytes(&c.card_ref)),
        (int(14), bytes(&c.parent)),
    ];
    map.extend(signed_entries(
        c.chain_id,
        c.verifying_contract,
        c.mode,
        c.legs,
    ));
    encode(Value::Map(map))
}

/// A card settlement's payload.
pub fn card_settlement_claims_bytes(c: &CardSettlementClaims<'_>) -> Vec<u8> {
    let t = c.settlement;
    let mut map = vec![
        (int(1), int(2)),
        (int(2), bytes(t.requestId.as_slice())),
        (int(3), bytes(t.cardRef.as_slice())),
        (int(4), bytes(t.transactionHash.as_slice())),
        (int(5), int(t.settledMinor)),
        (int(6), int(t.currency)),
        (int(7), int(t.status)),
        (int(8), int(t.settledAt.to::<u64>())),
        (int(9), int(t.observedAt.to::<u64>())),
        (int(14), bytes(&c.parent)),
    ];
    map.extend(signed_entries(
        c.chain_id,
        c.verifying_contract,
        c.mode,
        c.legs,
    ));
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

/// `SHA-256(salt ‖ order_id ‖ 0x00 ‖ authorization_id)`: the PayPal payment reference a purchase
/// statement commits to (the TypeScript `paypalRefCommit`).
pub fn pay_ref(salt: &[u8; 32], order_id: &str, authorization_id: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(salt);
    h.update(order_id.as_bytes());
    h.update([0]);
    h.update(authorization_id.as_bytes());
    h.finalize().into()
}

/// `SHA-256("keelson/card-ref/v1" ‖ 0x00 ‖ salt ‖ issuer ‖ 0x00 ‖ card_token)`: the card a card
/// statement commits to (the TypeScript `cardRefCommit`).
pub fn card_ref(salt: &[u8; 32], issuer: &str, card_token: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"keelson/card-ref/v1\0");
    h.update(salt);
    h.update(issuer.as_bytes());
    h.update([0]);
    h.update(card_token.as_bytes());
    h.finalize().into()
}

/// COSE algorithm Ed25519 (RFC 9864).
pub const ALG_ED25519: i64 = -19;

/// The protected header of an origin's RFC 9942 inclusion receipts: Ed25519, the key's SHA-256
/// as kid, the log host as issuer and the origin as subject, and `vds` RFC9162_SHA256.
pub fn receipt_protected(public: &[u8; 32], origin: &str) -> Vec<u8> {
    let kid: [u8; 32] = Sha256::digest(public).into();
    let host = origin.split('/').next().unwrap_or(origin);
    encode(Value::Map(vec![
        (int(1), int(ALG_ED25519)),
        (int(4), bytes(&kid)),
        (
            int(15),
            Value::Map(vec![
                (int(1), Value::Text(format!("https://{host}"))),
                (int(2), Value::Text(origin.into())),
            ]),
        ),
        (int(395), int(1)),
    ]))
}

/// RFC 9162 §2.1.1 leaf hash: `SHA-256(0x00 ‖ entry)`.
pub fn leaf_hash(entry: &[u8]) -> [u8; 32] {
    Sha256::new()
        .chain_update([0])
        .chain_update(entry)
        .finalize()
        .into()
}

fn node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    Sha256::new()
        .chain_update([1])
        .chain_update(left)
        .chain_update(right)
        .finalize()
        .into()
}

/// RFC 9162 §2.1.3.2: the root an inclusion path yields, or `None` for a malformed proof.
pub fn root_from_inclusion(
    leaf_hash: &[u8; 32],
    index: u64,
    size: u64,
    path: &[[u8; 32]],
) -> Option<[u8; 32]> {
    if index >= size {
        return None;
    }
    let (mut f, mut s) = (index, size - 1);
    let mut r = *leaf_hash;
    for p in path {
        if s == 0 {
            return None;
        }
        if f & 1 == 1 || f == s {
            r = node(p, &r);
            while f & 1 == 0 && f != 0 {
                f >>= 1;
                s >>= 1;
            }
        } else {
            r = node(&r, p);
        }
        f >>= 1;
        s >>= 1;
    }
    (s == 0).then_some(r)
}

/// An RFC 9942 inclusion receipt with a detached root and one inclusion proof.
pub fn build_receipt(
    protected: &[u8],
    signature: [u8; 64],
    size: u64,
    index: u64,
    path: &[[u8; 32]],
) -> Vec<u8> {
    let proof = encode(Value::Array(vec![
        int(size),
        int(index),
        Value::Array(path.iter().map(|h| bytes(h)).collect()),
    ]));
    encode(Value::Tag(
        COSE_SIGN1_TAG,
        Box::new(Value::Array(vec![
            Value::Bytes(protected.to_vec()),
            Value::Map(vec![(
                int(396),
                Value::Map(vec![(int(-1), Value::Array(vec![Value::Bytes(proof)]))]),
            )]),
            Value::Null,
            bytes(&signature),
        ])),
    ))
}

/// What a verified receipt states.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedReceipt {
    pub size: u64,
    pub index: u64,
    pub root: [u8; 32],
    pub path: Vec<[u8; 32]>,
    /// The key, of those given, that signed it.
    pub key: [u8; 32],
}

fn map_get(map: &[(Value, Value)], key: i64) -> Option<&Value> {
    map.iter()
        .find(|(k, _)| k.as_integer() == Some(key.into()))
        .map(|(_, v)| v)
}

fn as_u64(v: &Value) -> Option<u64> {
    u64::try_from(v.as_integer()?).ok()
}

fn fixed<const N: usize>(v: Option<&Value>) -> Option<[u8; N]> {
    v?.as_bytes()?.as_slice().try_into().ok()
}

/// A COSE_Sign1's protected bytes, unprotected map, payload (`None` when detached) and signature.
type Sign1Parts = (Vec<u8>, Vec<(Value, Value)>, Option<Vec<u8>>, Vec<u8>);

/// Decodes a tagged COSE_Sign1 into its four fields.
fn sign1(bytes: &[u8]) -> Option<Sign1Parts> {
    let value: Value = ciborium::from_reader(bytes).ok()?;
    let Value::Tag(COSE_SIGN1_TAG, inner) = value else {
        return None;
    };
    let Value::Array(parts) = *inner else {
        return None;
    };
    let [protected, unprotected, payload, signature] = <[Value; 4]>::try_from(parts).ok()?;
    let payload = match payload {
        Value::Null => None,
        Value::Bytes(b) => Some(b),
        _ => return None,
    };
    Some((
        protected.into_bytes().ok()?,
        unprotected.into_map().ok()?,
        payload,
        signature.into_bytes().ok()?,
    ))
}

/// Verifies an RFC 9942 Ed25519 inclusion receipt of `entry` under one of `keys` (RFC 9942
/// §5.2): the path yields the root, which is the detached payload the signature covers.
pub fn verify_receipt(receipt: &[u8], entry: &[u8], keys: &[[u8; 32]]) -> Option<VerifiedReceipt> {
    let (protected, unprotected, payload, signature) = sign1(receipt)?;
    if payload.is_some() {
        return None;
    }
    let header: Value = ciborium::from_reader(protected.as_slice()).ok()?;
    let header = header.as_map()?;
    if as_u64(map_get(header, 395)?)? != 1
        || map_get(header, 1)?.as_integer()? != ALG_ED25519.into()
    {
        return None;
    }
    let kid: [u8; 32] = fixed(map_get(header, 4))?;
    let key = *keys
        .iter()
        .find(|k| <[u8; 32]>::from(Sha256::digest(k.as_slice())) == kid)?;
    let proofs = map_get(map_get(&unprotected, 396)?.as_map()?, -1)?.as_array()?;
    let [proof] = proofs.as_slice() else {
        return None;
    };
    let content: Value = ciborium::from_reader(proof.as_bytes()?.as_slice()).ok()?;
    let content = content.as_array()?;
    let [size, index, path] = content.as_slice() else {
        return None;
    };
    let (size, index) = (as_u64(size)?, as_u64(index)?);
    let path = path
        .as_array()?
        .iter()
        .map(|h| h.as_bytes()?.as_slice().try_into().ok())
        .collect::<Option<Vec<[u8; 32]>>>()?;
    let root = root_from_inclusion(&leaf_hash(entry), index, size, &path)?;
    let sig = ed25519_dalek::Signature::from_slice(&signature).ok()?;
    ed25519_dalek::VerifyingKey::from_bytes(&key)
        .ok()?
        .verify_strict(&to_be_signed(&protected, &root), &sig)
        .ok()?;
    Some(VerifiedReceipt {
        size,
        index,
        root,
        path,
        key,
    })
}

/// A purchase statement read back, signatures unchecked.
#[derive(Clone)]
pub struct ReadStatement {
    pub alibi_id: String,
    pub kid: [u8; 20],
    pub protected: Vec<u8>,
    pub claims_bytes: Vec<u8>,
    pub signature: [u8; 64],
    /// The statement as the log registered it: no unprotected header.
    pub registered: Vec<u8>,
    /// The receipts (label 394) a transparent statement carries.
    pub receipts: Vec<Vec<u8>>,
    pub countersign: Countersign,
    pub chain_id: u64,
    pub verifying_contract: [u8; 20],
    pub mode: Mode,
    pub legs: Vec<LegSignature>,
    pub pay_ref: Option<[u8; 32]>,
}

/// Reads a purchase statement, registered or transparent, without checking any signature; the
/// caller checks them. `None` unless every claim has the shape [`claims_bytes`] writes.
pub fn read_purchase(statement_bytes: &[u8]) -> Option<ReadStatement> {
    use alloy_primitives::{B256, U256, aliases::U40};
    let (protected, unprotected, payload, signature) = sign1(statement_bytes)?;
    let header: Value = ciborium::from_reader(protected.as_slice()).ok()?;
    let header = header.as_map()?;
    if map_get(header, 3)?.as_text()? != CLAIMS_CONTENT_TYPE {
        return None;
    }
    let kid: [u8; 20] = fixed(map_get(header, 4))?;
    let alibi_id = map_get(map_get(header, 15)?.as_map()?, 2)?
        .as_text()?
        .to_owned();
    let payload = payload?;
    let claims: Value = ciborium::from_reader(payload.as_slice()).ok()?;
    let m = claims.as_map()?;
    let b32 = |k: i64| fixed::<32>(map_get(m, k)).map(B256::new);
    let u = |k: i64| as_u64(map_get(m, k)?);
    let agent = match map_get(m, 6)? {
        Value::Tag(2, b) => U256::try_from_be_slice(b.as_bytes()?)?,
        v => U256::from(as_u64(v)?),
    };
    let countersign = Countersign {
        requestId: b32(2)?,
        mandateHash: b32(3)?,
        mandateCommitment: b32(4)?,
        cartHash: b32(5)?,
        agentId: agent,
        merchantId: b32(7)?,
        amount: u(8)?,
        currency: u16::try_from(u(9)?).ok()?,
        category: u8::try_from(u(10)?).ok()?,
        evidenceRoot: b32(11)?,
        evalHash: b32(12)?,
        policySetHash: b32(13)?,
        decision: u8::try_from(u(14)?).ok()?,
        failedFieldsMask: u32::try_from(u(15)?).ok()?,
        issuedAt: U40::from(u(16)?),
        expiresAt: U40::from(u(17)?),
    };
    let mode = match u(20)? {
        1 => Mode::TwoOfTwo,
        2 => Mode::Degraded,
        _ => return None,
    };
    let legs = map_get(m, 21)?
        .as_array()?
        .iter()
        .map(|l| {
            let l = l.as_array()?;
            Some(LegSignature {
                kind: u8::try_from(as_u64(l.first()?)?).ok()?,
                signer: fixed(l.get(1))?,
                signature: fixed(l.get(2))?,
                measurement: fixed(l.get(3))?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let read = ReadStatement {
        alibi_id,
        kid,
        signature: signature.as_slice().try_into().ok()?,
        registered: statement(
            protected.clone(),
            payload.clone(),
            signature.as_slice().try_into().ok()?,
        ),
        receipts: map_get(&unprotected, 394)
            .and_then(Value::as_array)
            .map(|r| r.iter().filter_map(|x| x.as_bytes().cloned()).collect())
            .unwrap_or_default(),
        chain_id: u(18)?,
        verifying_contract: fixed(map_get(m, 19))?,
        mode,
        pay_ref: fixed(map_get(m, 22)),
        legs,
        countersign,
        protected,
        claims_bytes: payload,
    };
    // Only the canonical claims: what `claims_bytes` writes for them, byte for byte.
    let rewritten = claims_bytes(&StatementClaims {
        countersign: &read.countersign,
        chain_id: read.chain_id,
        verifying_contract: read.verifying_contract,
        mode: read.mode,
        legs: &read.legs,
        pay_ref: read.pay_ref,
    });
    (rewritten == read.claims_bytes).then_some(read)
}

/// A registered statement with `receipts` in its unprotected header (label 394): the
/// transparent statement (RFC 9943). `None` if `registered` is not a COSE_Sign1.
pub fn with_receipts(registered: &[u8], receipts: &[Vec<u8>]) -> Option<Vec<u8>> {
    let (protected, _, payload, signature) = sign1(registered)?;
    Some(encode(Value::Tag(
        COSE_SIGN1_TAG,
        Box::new(Value::Array(vec![
            Value::Bytes(protected),
            Value::Map(vec![(
                int(394),
                Value::Array(receipts.iter().map(|r| Value::Bytes(r.clone())).collect()),
            )]),
            payload.map_or(Value::Null, Value::Bytes),
            Value::Bytes(signature),
        ])),
    )))
}
