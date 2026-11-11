//! Witnessed log checkpoints: the c2sp.org/tlog-checkpoint notes both legs sign as the EIP-712
//! `Checkpoint` that `CheckpointAnchor` accepts.
//!
//! A note is accepted only for a known origin, with a valid Ed25519 signature of the origin's log
//! key (c2sp.org/signed-note) and `cosignature/v1` signatures of at least the origin's quorum of
//! its witnesses (c2sp.org/tlog-cosignature). Signatures of unknown keys, such as the log's
//! ML-DSA-44 one, are ignored as signed-note requires.

use std::fmt;

use alloy_primitives::{B256, keccak256};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use ed25519_dalek::{Signature, VerifyingKey};
use keelson_core::eip712::Checkpoint;
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

/// A log whose checkpoints the engine signs: its origin, the chain its anchors go to, its log
/// key and witnesses as note verifier keys (`<name>+<key id>+<base64(type ‖ key)>`), and how many
/// of the witnesses must cosign.
#[derive(Clone, Copy, Debug)]
pub struct LogOrigin {
    pub name: &'static str,
    pub chain_id: u64,
    pub log_key: &'static str,
    pub witnesses: &'static [&'static str],
    pub quorum: usize,
}

const OWN_WITNESSES: [&str; 3] = [
    "witness-1.keelson.finance+f179740d+BA2CNkIvGf1TnnZNrT8I4QEE3VFdcK71m1HOqlHv6INc",
    "witness-2.keelson.finance+25bcde99+BG9zFgsma2ggzGNea4Nm1oG1/011LGpfypKDmR5Qi2ox",
    "witness-3.keelson.finance+9d46cab2+BHzNOrCnXA/4RzT9dabueqKXrTRswymwxybNZrcNkmX4",
];

/// The logs of `services/log/policy`. The conformance log is a test origin whose checkpoints,
/// forks included, are signed with its log key alone, so drills can be anchored; nothing trusts it.
pub const ORIGINS: [LogOrigin; 3] = [
    LogOrigin {
        name: "log.keelson.finance/alibi/2026-1",
        chain_id: 421_614,
        log_key: "log.keelson.finance/alibi/2026-1+8553fcbd+ATEHrhTfdzkwLLgf9SZhMsIhsHzRmvpFnaBfgK0D10Id",
        witnesses: &OWN_WITNESSES,
        quorum: 2,
    },
    LogOrigin {
        name: "log.keelson.finance/alibi-live/2026-1",
        chain_id: 42_161,
        log_key: "log.keelson.finance/alibi-live/2026-1+39e7ebfa+AUiaY8TAW9gFbueTv6mPbHeZq5ClgTnG9a4kGEnU5uyL",
        witnesses: &OWN_WITNESSES,
        quorum: 2,
    },
    LogOrigin {
        name: "log.keelson.finance/conformance/2026-1",
        chain_id: 421_614,
        log_key: "log.keelson.finance/conformance/2026-1+88ff219b+Ac7nwLU+DHM6Go1EhwEz+nzxcYelAsfPN+Qp7qWo1WXV",
        witnesses: &[],
        quorum: 0,
    },
];

/// Signature type of an Ed25519 note signature.
const TYPE_ED25519: u8 = 0x01;
/// Signature type of an Ed25519 checkpoint cosignature.
const TYPE_COSIGNATURE: u8 = 0x04;
/// How far ahead of the engine's clock a cosignature timestamp may be, in seconds.
const MAX_COSIGNATURE_AHEAD: i64 = 600;

/// Why a checkpoint is not signed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckpointError {
    /// Not a signed note, extension lines, a size that is not decimal or a root that is not 32
    /// bytes of canonical base64.
    Format,
    /// The origin is none of [`ORIGINS`].
    Origin,
    /// The origin anchors on another chain than the one asked for.
    Chain,
    /// No valid signature of the origin's log key.
    LogSignature,
    /// Fewer valid witness cosignatures than the origin's quorum.
    Quorum,
}

impl CheckpointError {
    /// The stable error code.
    pub fn code(self) -> &'static str {
        match self {
            Self::Format => "checkpoint_format",
            Self::Origin => "checkpoint_origin",
            Self::Chain => "checkpoint_chain",
            Self::LogSignature => "checkpoint_log_signature",
            Self::Quorum => "checkpoint_quorum",
        }
    }
}

impl fmt::Display for CheckpointError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for CheckpointError {}

/// A note verifier key.
struct NoteKey<'a> {
    name: &'a str,
    id: [u8; 4],
    key: VerifyingKey,
}

impl<'a> NoteKey<'a> {
    /// Parses `<name>+<hex key id>+<base64(type ‖ key)>` of signature type `kind`, checking the
    /// key id is `SHA-256(name ‖ "\n" ‖ type ‖ key)[:4]`.
    fn parse(vkey: &'a str, kind: u8) -> Option<Self> {
        // Names never contain `+`; the base64 key may.
        let (name, rest) = vkey.split_once('+')?;
        let (id_hex, encoded) = rest.split_once('+')?;
        let raw = STANDARD.decode(encoded).ok()?;
        let (&[t], key) = raw.split_first_chunk::<1>()?;
        let key: &[u8; 32] = key.try_into().ok()?;
        let id = note_key_id(name, t, key);
        let hex: String = id.iter().map(|b| format!("{b:02x}")).collect();
        (t == kind && hex == id_hex).then_some(Self {
            name,
            id,
            key: VerifyingKey::from_bytes(key).ok()?,
        })
    }
}

/// The note key id, `SHA-256(name ‖ "\n" ‖ type ‖ key)[:4]`.
pub(crate) fn note_key_id(name: &str, kind: u8, key: &[u8]) -> [u8; 4] {
    let hash = Sha256::new()
        .chain_update(name)
        .chain_update([b'\n', kind])
        .chain_update(key)
        .finalize();
    [hash[0], hash[1], hash[2], hash[3]]
}

/// The origin named `name`.
pub fn origin(name: &str) -> Option<&'static LogOrigin> {
    ORIGINS.iter().find(|o| o.name == name)
}

/// Verifies a signed checkpoint note against its origin's policy and returns the `Checkpoint`
/// it states, for an anchor on `chain_id`. `tee_keys` are the Ed25519 log keys leg A holds,
/// `(origin, key)`, trusted for their origin besides its pinned key.
pub fn verify_checkpoint(
    note: &[u8],
    chain_id: u64,
    now: OffsetDateTime,
    tee_keys: &[(&str, [u8; 32])],
) -> Result<Checkpoint, CheckpointError> {
    use CheckpointError::*;
    let note = std::str::from_utf8(note).map_err(|_| Format)?;
    if note.bytes().any(|b| b < 0x20 && b != b'\n') {
        return Err(Format);
    }
    let split = note.find("\n\n").ok_or(Format)?;
    let (text, signatures) = (&note[..=split], &note[split + 2..]);
    let mut lines = text.lines();
    let (Some(name), Some(size), Some(root), None) =
        (lines.next(), lines.next(), lines.next(), lines.next())
    else {
        return Err(Format);
    };
    let tree_size = parse_decimal(size).ok_or(Format)?;
    let root: [u8; 32] = STANDARD
        .decode(root)
        .ok()
        .and_then(|r| r.try_into().ok())
        .filter(|r: &[u8; 32]| STANDARD.encode(r) == root)
        .ok_or(Format)?;
    let origin = origin(name).ok_or(Origin)?;
    if origin.chain_id != chain_id {
        return Err(Chain);
    }
    let mut log_keys = vec![NoteKey::parse(origin.log_key, TYPE_ED25519).expect("a valid log key")];
    for (_, key) in tee_keys.iter().filter(|(o, _)| *o == origin.name) {
        if let Ok(key) = VerifyingKey::from_bytes(key) {
            log_keys.push(NoteKey {
                name: origin.name,
                id: note_key_id(origin.name, TYPE_ED25519, key.as_bytes()),
                key,
            });
        }
    }
    let witnesses: Vec<NoteKey> = origin
        .witnesses
        .iter()
        .map(|w| NoteKey::parse(w, TYPE_COSIGNATURE).expect("a valid witness key"))
        .collect();

    let mut log_signed = false;
    let mut cosigned = vec![false; witnesses.len()];
    if signatures.is_empty() || !signatures.ends_with('\n') {
        return Err(Format);
    }
    for line in signatures.lines() {
        let (signer, encoded) = line
            .strip_prefix("\u{2014} ")
            .and_then(|l| l.split_once(' '))
            .ok_or(Format)?;
        let raw = STANDARD.decode(encoded).map_err(|_| Format)?;
        let Some((id, sig)) = raw.split_first_chunk::<4>() else {
            return Err(Format);
        };
        if let Some(log_key) = log_keys.iter().find(|k| k.name == signer && k.id == *id) {
            let ok =
                <&[u8; 64]>::try_from(sig).is_ok_and(|s| verify(&log_key.key, text.as_bytes(), s));
            if !ok {
                return Err(LogSignature);
            }
            log_signed = true;
            continue;
        }
        let Some(i) = witnesses
            .iter()
            .position(|w| w.name == signer && w.id == *id)
        else {
            continue;
        };
        let Some((time, sig)) = sig.split_first_chunk::<8>() else {
            continue;
        };
        let Ok(sig) = <&[u8; 64]>::try_from(sig) else {
            continue;
        };
        let time = u64::from_be_bytes(*time);
        let fresh = i64::try_from(time)
            .is_ok_and(|t| t <= now.unix_timestamp().saturating_add(MAX_COSIGNATURE_AHEAD));
        let message = format!("cosignature/v1\ntime {time}\n{text}");
        if fresh && verify(&witnesses[i].key, message.as_bytes(), sig) {
            cosigned[i] = true;
        }
    }
    if !log_signed {
        return Err(LogSignature);
    }
    if cosigned.iter().filter(|&&c| c).count() < origin.quorum {
        return Err(Quorum);
    }
    Ok(Checkpoint {
        origin: keccak256(origin.name),
        treeSize: tree_size,
        rootHash: B256::new(root),
    })
}

fn verify(key: &VerifyingKey, message: &[u8], signature: &[u8; 64]) -> bool {
    key.verify_strict(message, &Signature::from_bytes(signature))
        .is_ok()
}

/// A decimal `u64` without sign or leading zeros.
fn parse_decimal(s: &str) -> Option<u64> {
    let canonical =
        !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'));
    canonical.then(|| s.parse().ok()).flatten()
}

#[cfg(test)]
mod tests {
    use super::{NoteKey, ORIGINS, TYPE_COSIGNATURE, TYPE_ED25519, parse_decimal};

    #[test]
    fn every_key_parses_with_its_key_id() {
        for o in ORIGINS {
            assert!(
                NoteKey::parse(o.log_key, TYPE_ED25519).is_some(),
                "{}",
                o.name
            );
            assert!(o.log_key.starts_with(&format!("{}+", o.name)));
            for w in o.witnesses {
                assert!(NoteKey::parse(w, TYPE_COSIGNATURE).is_some(), "{w}");
            }
            assert!(o.quorum <= o.witnesses.len());
        }
    }

    #[test]
    fn sizes_are_canonical_decimals() {
        assert_eq!(parse_decimal("0"), Some(0));
        assert_eq!(parse_decimal("54"), Some(54));
        assert_eq!(parse_decimal("18446744073709551615"), Some(u64::MAX));
        for bad in ["", "054", "+5", "-1", "5 ", "18446744073709551616", "0x10"] {
            assert_eq!(parse_decimal(bad), None, "{bad}");
        }
    }
}
