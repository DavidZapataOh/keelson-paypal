//! Keelson's Token Status List (draft-ietf-oauth-status-list-21): leg A signs the list of its
//! mandates with the credential issuer key, and only a list that keeps every bit already set;
//! both legs check a mandate's bit on every countersign.

use std::io::{Read, Write};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use flate2::Compression;
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use keelson_mandate::{STATUS_SIZE, StatusRef};
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{Root, SealAad, UserRecords};

/// The `typ` of a status list token (section 5.1).
pub const STATUS_TYP: &str = "statuslist+jwt";
/// How long a relying party may cache the token, in seconds (`ttl`).
pub const STATUS_TTL: i64 = 300;
/// How long the token is valid, in seconds (`exp` − `iat`).
pub const STATUS_LIFETIME: i64 = 900;
/// The list's bytes: one bit per mandate.
pub const STATUS_BYTES: usize = STATUS_SIZE as usize / 8;
const PURPOSE: &str = "keelson/seal/status/v1";

/// The bit array of a `lst` (section 4.1): base64url of the ZLIB (RFC 1950) compressed bytes,
/// exactly [`STATUS_BYTES`] long.
pub fn decode_list(lst: &str) -> Option<Vec<u8>> {
    let compressed = B64.decode(lst).ok()?;
    let mut out = Vec::with_capacity(STATUS_BYTES);
    ZlibDecoder::new(compressed.as_slice())
        .take(STATUS_BYTES as u64 + 1)
        .read_to_end(&mut out)
        .ok()?;
    (out.len() == STATUS_BYTES).then_some(out)
}

/// The `lst` of a bit array.
pub fn encode_list(bits: &[u8]) -> String {
    let mut z = ZlibEncoder::new(Vec::new(), Compression::best());
    z.write_all(bits).expect("writing to a Vec cannot fail");
    B64.encode(z.finish().expect("writing to a Vec cannot fail"))
}

/// Whether the status at `idx` is set: bit `idx % 8` (least significant first) of byte `idx / 8`.
pub fn is_set(bits: &[u8], idx: u32) -> bool {
    let i = idx as usize;
    bits.get(i / 8).is_some_and(|b| b >> (i % 8) & 1 == 1)
}

/// Whether `new` keeps every bit `old` has set.
pub fn extends(old: &[u8], new: &[u8]) -> bool {
    old.len() == new.len() && old.iter().zip(new).all(|(o, n)| o & !n == 0)
}

/// The status list token over `lst`: a compact ES256 JWS (section 5.1).
pub fn sign_token(key: &SigningKey, kid: &str, uri: &str, lst: &str, iat: i64) -> String {
    let header = json!({ "alg": "ES256", "kid": kid, "typ": STATUS_TYP });
    let claims = json!({
        "sub": uri,
        "iat": iat,
        "exp": iat + STATUS_LIFETIME,
        "ttl": STATUS_TTL,
        "status_list": { "bits": 1, "lst": lst },
    });
    let input = format!(
        "{}.{}",
        B64.encode(header.to_string()),
        B64.encode(claims.to_string())
    );
    let signature: Signature = key.sign(input.as_bytes());
    format!("{input}.{}", B64.encode(signature.to_bytes()))
}

/// Why a status list token cannot back a countersign.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusError {
    /// Not a token the issuer signed for this list, or not fresh.
    Invalid,
    /// The mandate's bit is set.
    Revoked,
}

/// Checks `token` for the mandate at `status`: signed by `issuer`, for its list, issued at most
/// [`STATUS_TTL`] seconds before `now` and not expired, and the mandate's bit clear.
pub fn check_token(
    token: &str,
    issuer: &VerifyingKey,
    status: &StatusRef,
    now: i64,
) -> Result<(), StatusError> {
    let parts: Vec<&str> = token.split('.').collect();
    let [h, c, s] = parts.as_slice() else {
        return Err(StatusError::Invalid);
    };
    let json = |p: &str| -> Option<Value> { serde_json::from_slice(&B64.decode(p).ok()?).ok() };
    let (header, claims) = json(h).zip(json(c)).ok_or(StatusError::Invalid)?;
    let signature = B64
        .decode(s)
        .ok()
        .and_then(|b| Signature::from_slice(&b).ok())
        .ok_or(StatusError::Invalid)?;
    if header["alg"] != "ES256"
        || header["typ"] != STATUS_TYP
        || issuer
            .verify(format!("{h}.{c}").as_bytes(), &signature)
            .is_err()
    {
        return Err(StatusError::Invalid);
    }
    let iat = claims["iat"].as_i64().ok_or(StatusError::Invalid)?;
    let exp = claims["exp"].as_i64().ok_or(StatusError::Invalid)?;
    if claims["sub"] != status.uri.as_str()
        || claims["status_list"]["bits"] != 1
        || iat < now - STATUS_TTL
        || exp <= now
    {
        return Err(StatusError::Invalid);
    }
    let bits = claims["status_list"]["lst"]
        .as_str()
        .and_then(decode_list)
        .ok_or(StatusError::Invalid)?;
    if is_set(&bits, status.idx) {
        return Err(StatusError::Revoked);
    }
    Ok(())
}

/// The digest leg A keeps of each token it signed, to know which one is current.
pub fn token_digest(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

/// Leg A's durable record of the lists it signed, sealed with the KMS root: one record per
/// token, appended in order, holding the token's digest and the list. The latest is the one a
/// countersign must present, and no later list may clear a bit it sets.
pub(crate) struct DurableStatus<'a> {
    pub(crate) root: &'a Root,
    pub(crate) users: &'a dyn UserRecords,
}

/// A signed list as leg A recorded it.
pub(crate) struct Signed {
    pub(crate) n: usize,
    pub(crate) token: [u8; 32],
    pub(crate) bits: Vec<u8>,
}

impl DurableStatus<'_> {
    fn key(uri: &str, n: usize) -> String {
        let id: String = Sha256::digest(uri.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        format!("status\0{id}\0{n}")
    }

    fn get(&self, uri: &str, n: usize) -> Option<Signed> {
        let blob = self.users.get(&Self::key(uri, n))?;
        let record = format!("{uri}\0{n}");
        let aad = SealAad {
            purpose: PURPOSE,
            sub: None,
            record: record.as_bytes(),
        };
        let plain = self.root.unseal(&aad, &blob).ok()?;
        let (token, bits) = plain.split_at_checked(32)?;
        Some(Signed {
            n,
            token: token.try_into().ok()?,
            bits: bits.to_vec(),
        })
    }

    /// The latest list signed for `uri`, starting the search at record `from`.
    pub(crate) fn latest(&self, uri: &str, from: usize) -> Option<Signed> {
        let mut last = None;
        let mut n = from;
        while let Some(s) = self.get(uri, n) {
            last = Some(s);
            n += 1;
        }
        last.or_else(|| (from > 0).then(|| self.latest(uri, 0)).flatten())
    }

    /// Records `token` over `bits` as record `n`; `false` when another took that place first.
    pub(crate) fn append(&self, uri: &str, n: usize, token: &str, bits: &[u8]) -> bool {
        let record = format!("{uri}\0{n}");
        let aad = SealAad {
            purpose: PURPOSE,
            sub: None,
            record: record.as_bytes(),
        };
        let plain = [&token_digest(token)[..], bits].concat();
        self.users
            .insert_new(&Self::key(uri, n), self.root.seal(&aad, &plain))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_round_trips_and_bits_read_least_significant_first() {
        let mut bits = vec![0u8; STATUS_BYTES];
        bits[0] = 0b0000_0010;
        bits[STATUS_BYTES - 1] = 0b1000_0000;
        let lst = encode_list(&bits);
        assert_eq!(decode_list(&lst).unwrap(), bits);
        assert!(is_set(&bits, 1) && !is_set(&bits, 0));
        assert!(is_set(&bits, STATUS_SIZE - 1));
        assert!(decode_list(&encode_list(&[0u8; 10])).is_none());
    }

    #[test]
    fn a_list_extends_another_only_when_it_keeps_every_bit() {
        let old = [0b0101u8, 0];
        assert!(extends(&old, &[0b0111, 0]));
        assert!(extends(&old, &old));
        assert!(!extends(&old, &[0b0100, 1]));
    }

    #[test]
    fn an_all_valid_list_is_small() {
        assert!(encode_list(&vec![0u8; STATUS_BYTES]).len() < 1024);
    }
}
