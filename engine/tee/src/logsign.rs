//! The log's checkpoint signer, held by leg A.
//!
//! The Ed25519 key of each Alibi origin is derived by the dstack KMS for this app
//! (`GetKey(keelson/log/<origin>/v1, ed25519)`) and never leaves the leg. The leg signs a
//! c2sp.org/tlog-checkpoint body only if it extends the last tree it signed for the origin: the
//! same size with the same root, or a larger size with an RFC 6962 consistency proof from the
//! last one. Every tree it signs is recorded before the signature leaves, each size once and each
//! with one successor, so the signed trees of an origin form one history: no caller, the log's
//! operator included, can get two views signed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use ed25519_dalek::{Signer as _, SigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::checkpoint::note_key_id;
use crate::{Root, SealAad, UserRecords};

/// The origins whose key leg A holds.
pub const SIGNED_ORIGINS: [&str; 2] = [
    "log.keelson.finance/alibi/2026-1",
    "log.keelson.finance/alibi-live/2026-1",
];

/// The dstack `GetKey` domain of an origin's log key.
pub fn key_domain(origin: &str) -> String {
    format!("keelson/log/{origin}/v1")
}

const SEAL_PURPOSE: &str = "keelson/seal/log-checkpoint/v1";
/// Longest consistency proof between trees of up to 2^64 - 1 leaves (RFC 9162 §2.1.4.1).
const MAX_PROOF: usize = 65;

/// A log key with the KMS signature chain that proves the app derived it.
pub struct LogKey {
    pub origin: &'static str,
    key: SigningKey,
    /// `GetKey`'s `signature_chain`: the app root key's signature over the key claim and the
    /// KMS root key's signature over the app root key.
    pub signature_chain: Vec<Vec<u8>>,
}

impl LogKey {
    /// A key from the 32-byte Ed25519 seed `GetKey` returned.
    pub fn new(
        origin: &'static str,
        seed: &Zeroizing<[u8; 32]>,
        signature_chain: Vec<Vec<u8>>,
    ) -> Self {
        Self {
            origin,
            key: SigningKey::from_bytes(seed),
            signature_chain,
        }
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }

    /// The note verifier key, `<origin>+<key id>+<base64(0x01 ‖ key)>`.
    pub fn vkey(&self) -> String {
        vkey(self.origin, &self.public_key())
    }
}

/// The note verifier key of the Ed25519 key `public` named `origin`.
pub fn vkey(origin: &str, public: &[u8; 32]) -> String {
    let id = note_key_id(origin, 0x01, public);
    let mut raw = vec![0x01];
    raw.extend_from_slice(public);
    format!("{origin}+{}+{}", hex(&id), STANDARD.encode(raw))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `POST /v1/log/sign`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignRequest {
    /// The checkpoint body: origin, decimal size and base64 root lines, nothing else.
    pub checkpoint: String,
    /// The size the consistency proof starts from: the last size this leg signed for the origin;
    /// absent for an origin it never signed.
    pub from_size: Option<u64>,
    /// The RFC 6962 consistency proof from `from_size`, as base64 hashes.
    #[serde(default)]
    pub consistency: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Signed {
    /// The 64-byte Ed25519 signature over the body, base64.
    pub signature: String,
    /// The note verifier key that signed.
    pub vkey: String,
}

/// Why a checkpoint was not signed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignError {
    /// Not a checkpoint body, or a malformed proof.
    Format,
    /// An origin whose key this leg does not hold.
    Origin,
    /// The checkpoint does not extend the last tree signed for the origin, whose size is given.
    NotExtending { latest: Option<u64> },
    /// The records could not be read or written.
    Records,
    /// The leg has signed nothing for the origin and its on-chain anchor could not be read.
    NoFloor,
}

impl SignError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Format => "log_format",
            Self::Origin => "log_origin",
            Self::NotExtending { .. } => "log_not_extending",
            Self::Records => "log_records",
            Self::NoFloor => "log_no_anchor",
        }
    }
}

/// The last tree signed for an origin, recovered from the records at the first request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Tree {
    size: u64,
    root: [u8; 32],
}

pub struct LogSigner {
    keys: Vec<LogKey>,
    records: Arc<dyn UserRecords>,
    latest: Mutex<HashMap<&'static str, Option<Tree>>>,
}

impl LogSigner {
    pub fn new(keys: Vec<LogKey>, records: Arc<dyn UserRecords>) -> Self {
        Self {
            keys,
            records,
            latest: Mutex::new(HashMap::new()),
        }
    }

    pub fn keys(&self) -> &[LogKey] {
        &self.keys
    }

    /// Whether the leg has signed nothing for `origin` yet, so its first signature must extend
    /// the origin's on-chain anchor ([`LogSigner::sign`]'s `floor`).
    pub fn needs_floor(&self, root: &Root, origin: &str) -> Result<bool, SignError> {
        let Some(key) = self.keys.iter().find(|k| k.origin == origin) else {
            return Ok(false);
        };
        let mut latest = self.latest.lock().map_err(|_| SignError::Records)?;
        let last = match latest.get(key.origin) {
            Some(last) => *last,
            None => {
                let last = self.recover(root, key.origin)?;
                latest.insert(key.origin, last);
                last
            }
        };
        Ok(last.is_none())
    }

    /// Signs `r.checkpoint` if it extends the last tree signed for its origin or, when the leg
    /// has signed none, the origin's latest on-chain anchor `floor` (`(size, root)`, size 0 when
    /// nothing is anchored). The anchor bounds what a CVM with empty records, such as a new
    /// instance of the app, can sign: never a tree the chain shows another history for.
    pub fn sign(
        &self,
        root: &Root,
        floor: Option<(u64, [u8; 32])>,
        r: &SignRequest,
    ) -> Result<Signed, SignError> {
        let (origin, tree) = parse_body(&r.checkpoint).ok_or(SignError::Format)?;
        let key = self
            .keys
            .iter()
            .find(|k| k.origin == origin)
            .ok_or(SignError::Origin)?;
        if r.consistency.len() > MAX_PROOF {
            return Err(SignError::Format);
        }
        let proof = r
            .consistency
            .iter()
            .map(|h| {
                STANDARD
                    .decode(h)
                    .ok()
                    .and_then(|h| <[u8; 32]>::try_from(h).ok())
            })
            .collect::<Option<Vec<_>>>()
            .ok_or(SignError::Format)?;

        let mut latest = self.latest.lock().map_err(|_| SignError::Records)?;
        let last = match latest.get(key.origin) {
            Some(last) => *last,
            None => self.recover(root, key.origin)?,
        };
        let refuse = || SignError::NotExtending {
            latest: last.map(|t| t.size),
        };
        match last {
            Some(last) if tree.size == last.size => {
                if tree.root != last.root {
                    return Err(refuse());
                }
            }
            Some(last) => {
                if !extends(last, tree, r.from_size, &proof) {
                    return Err(refuse());
                }
                self.record(root, key.origin, &format!("next/{}", last.size), &tree)?;
            }
            None => {
                let (size, anchored) = floor.ok_or(SignError::NoFloor)?;
                let floor = Tree {
                    size,
                    root: anchored,
                };
                let extends_floor = size == 0
                    || (tree.size == size && tree.root == anchored)
                    || extends(floor, tree, r.from_size, &proof);
                if !extends_floor {
                    return Err(SignError::NotExtending { latest: Some(size) });
                }
                self.record(root, key.origin, "first", &tree)?;
            }
        }
        latest.insert(key.origin, Some(tree));
        drop(latest);

        let signature = key.key.sign(r.checkpoint.as_bytes());
        Ok(Signed {
            signature: STANDARD.encode(signature.to_bytes()),
            vkey: key.vkey(),
        })
    }

    /// Follows the origin's history from its first signed tree to the last.
    fn recover(&self, root: &Root, origin: &str) -> Result<Option<Tree>, SignError> {
        let Some(mut tree) = self.read(root, origin, "first")? else {
            return Ok(None);
        };
        while let Some(next) = self.read(root, origin, &format!("next/{}", tree.size))? {
            tree = next;
        }
        Ok(Some(tree))
    }

    fn read(&self, root: &Root, origin: &str, link: &str) -> Result<Option<Tree>, SignError> {
        let id = record_id(origin, link);
        let Some(blob) = self.records.get(&id) else {
            return Ok(None);
        };
        let aad = SealAad {
            purpose: SEAL_PURPOSE,
            sub: None,
            record: id.as_bytes(),
        };
        let plain = root.unseal(&aad, &blob).map_err(|_| SignError::Records)?;
        serde_json::from_slice(&plain)
            .map(Some)
            .map_err(|_| SignError::Records)
    }

    /// Records `tree` under `link`, once: a link already holding another tree refuses.
    fn record(
        &self,
        root: &Root,
        origin: &'static str,
        link: &str,
        tree: &Tree,
    ) -> Result<(), SignError> {
        let id = record_id(origin, link);
        let aad = SealAad {
            purpose: SEAL_PURPOSE,
            sub: None,
            record: id.as_bytes(),
        };
        let plain = serde_json::to_vec(tree).map_err(|_| SignError::Records)?;
        if self.records.insert_new(&id, root.seal(&aad, &plain)) {
            return Ok(());
        }
        match self.read(root, origin, link)? {
            Some(held) if held == *tree => Ok(()),
            _ => Err(SignError::NotExtending { latest: None }),
        }
    }
}

fn record_id(origin: &str, link: &str) -> String {
    format!("log\0{origin}\0{link}")
}

/// Whether `tree` is larger than `last` and `proof`, given from `from`, shows it extends `last`.
/// Every tree extends the empty one, which takes no proof (RFC 9162 §2.1.4).
fn extends(last: Tree, tree: Tree, from: Option<u64>, proof: &[[u8; 32]]) -> bool {
    tree.size > last.size
        && from == Some(last.size)
        && (last.size == 0
            || verify_consistency(last.size, tree.size, &last.root, &tree.root, proof))
}

/// Parses `<origin>\n<size>\n<base64 root>\n` with no extension lines.
fn parse_body(body: &str) -> Option<(&str, Tree)> {
    let text = body.strip_suffix('\n')?;
    let mut lines = text.split('\n');
    let (Some(origin), Some(size), Some(root), None) =
        (lines.next(), lines.next(), lines.next(), lines.next())
    else {
        return None;
    };
    let canonical = !size.is_empty()
        && size.bytes().all(|b| b.is_ascii_digit())
        && (size == "0" || !size.starts_with('0'));
    let size: u64 = canonical.then(|| size.parse().ok()).flatten()?;
    let root: [u8; 32] = STANDARD
        .decode(root)
        .ok()
        .and_then(|r| r.try_into().ok())
        .filter(|r: &[u8; 32]| STANDARD.encode(r) == root)?;
    Some((origin, Tree { size, root }))
}

fn node(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    Sha256::new()
        .chain_update([1])
        .chain_update(left)
        .chain_update(right)
        .finalize()
        .into()
}

/// RFC 9162 §2.1.4.2: whether `proof` shows the tree of `size2` leaves and root `root2` extends
/// the tree of `size1` leaves and root `root1`, `0 < size1 < size2`.
pub fn verify_consistency(
    size1: u64,
    size2: u64,
    root1: &[u8; 32],
    root2: &[u8; 32],
    proof: &[[u8; 32]],
) -> bool {
    if size1 == 0 || size1 >= size2 || proof.is_empty() {
        return false;
    }
    let mut proof = proof.iter();
    let (mut fn_, mut sn) = (size1 - 1, size2 - 1);
    let (mut fr, mut sr);
    if size1.is_power_of_two() {
        fr = *root1;
        sr = *root1;
    } else {
        let Some(first) = proof.next() else {
            return false;
        };
        fr = *first;
        sr = *first;
    }
    while fn_ & 1 == 1 {
        fn_ >>= 1;
        sn >>= 1;
    }
    for c in proof {
        if sn == 0 {
            return false;
        }
        if fn_ & 1 == 1 || fn_ == sn {
            fr = node(c, &fr);
            sr = node(c, &sr);
            if fn_ & 1 == 0 {
                while fn_ & 1 == 0 && fn_ != 0 {
                    fn_ >>= 1;
                    sn >>= 1;
                }
            }
        } else {
            sr = node(&sr, c);
        }
        fn_ >>= 1;
        sn >>= 1;
    }
    sn == 0 && fr == *root1 && sr == *root2
}
