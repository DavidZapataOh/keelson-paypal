use std::collections::{HashMap, HashSet};

use keelson_core::jcs;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::strict::{MAX_DEPTH, PROTOTYPE_NAMES, check};
use crate::{Error, b64};

fn invalid(reason: impl Into<String>) -> Error {
    Error::Disclosure(reason.into())
}

/// A decoded disclosure (RFC 9901 section 4.2.1 and 4.2.2).
pub(crate) struct Disclosure {
    pub key: Option<String>,
    pub value: Value,
}

/// The `sha-256` digest of a disclosure as presented (RFC 9901 section 4.2.3).
pub(crate) fn digest(encoded: &str) -> String {
    b64::encode(&Sha256::digest(encoded.as_bytes()))
}

impl Disclosure {
    pub(crate) fn decode(encoded: &str) -> Result<Self, Error> {
        let Some(Value::Array(mut parts)) = b64::decode_json(encoded) else {
            return Err(invalid("not a base64url JSON array"));
        };
        if !matches!(parts.len(), 2 | 3) || !parts[0].is_string() {
            return Err(invalid("invalid disclosure data"));
        }
        let value = parts.pop().expect("two or three parts");
        let key = match parts.pop().expect("two or three parts") {
            Value::String(_) if parts.is_empty() => None,
            Value::String(key) if key == "_sd" || key == "..." => {
                return Err(invalid(format!("reserved claim name {key:?}")));
            }
            Value::String(key) => Some(key),
            _ => return Err(invalid("claim name is not a string")),
        };
        Ok(Self { key, value })
    }
}

/// Rejects an `_sd_alg` that is present and not `sha-256` (RFC 9901 section 4.1.1).
pub(crate) fn assert_sd_alg(payload: &Map<String, Value>) -> Result<(), Error> {
    match payload.get("_sd_alg") {
        None => Ok(()),
        Some(alg) if alg == "sha-256" => Ok(()),
        Some(alg) => Err(invalid(format!("unsupported _sd_alg {alg}"))),
    }
}

struct Unpacker<'a> {
    map: &'a HashMap<String, Disclosure>,
    seen: HashSet<String>,
}

impl Unpacker<'_> {
    fn lookup(&mut self, digest: &str) -> Result<Option<&Disclosure>, Error> {
        if !self.seen.insert(digest.to_owned()) {
            return Err(invalid("duplicate digest in the payload"));
        }
        Ok(self.map.get(digest))
    }

    /// `nested` is whether the value sits below a non-empty claim path, and `depth` is the
    /// number of arrays and objects around it in the result.
    fn value(&mut self, v: &Value, nested: bool, depth: usize) -> Result<Value, Error> {
        match v {
            Value::Object(_) | Value::Array(_) if depth >= MAX_DEPTH => {
                Err(invalid("disclosed claims nested too deep"))
            }
            Value::Object(obj) => self.object(obj, nested, depth),
            Value::Array(items) => self.array(items, depth),
            other => Ok(other.clone()),
        }
    }

    fn array(&mut self, items: &[Value], depth: usize) -> Result<Value, Error> {
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let Some(obj) = item.as_object().filter(|o| o.contains_key("...")) else {
                out.push(self.value(item, true, depth + 1)?);
                continue;
            };
            let digest = match obj.get("...") {
                Some(Value::String(d)) if obj.len() == 1 => d,
                _ => return Err(invalid("invalid array element placeholder")),
            };
            match self.lookup(digest)? {
                None => {}
                Some(Disclosure { key: Some(_), .. }) => {
                    return Err(invalid("claim disclosure used as an array element"));
                }
                Some(Disclosure { key: None, value }) => {
                    let value = value.clone();
                    out.push(self.value(&value, true, depth + 1)?);
                }
            }
        }
        Ok(Value::Array(out))
    }

    fn object(
        &mut self,
        obj: &Map<String, Value>,
        nested: bool,
        depth: usize,
    ) -> Result<Value, Error> {
        let mut payload = Map::new();
        for (key, v) in obj {
            if nested && key == "_sd_alg" {
                return Err(invalid("nested _sd_alg"));
            }
            let v = match v {
                Value::Object(_) | Value::Array(_) if key != "_sd" && key != "..." => {
                    self.value(v, nested || !key.is_empty(), depth + 1)?
                }
                _ => v.clone(),
            };
            payload.insert(key.clone(), v);
        }
        let Some(sd) = payload.remove("_sd") else {
            return Ok(Value::Object(payload));
        };
        let digests = sd
            .as_array()
            .filter(|ds| ds.iter().all(Value::is_string))
            .ok_or_else(|| invalid("_sd is not an array of strings"))?;
        let mut claims = Map::new();
        for digest in digests.iter().filter_map(Value::as_str) {
            let (key, value) = match self.lookup(digest)? {
                None => continue,
                Some(Disclosure {
                    key: Some(key),
                    value,
                }) => (key.clone(), value.clone()),
                Some(_) => return Err(invalid("array disclosure used as a claim")),
            };
            if payload.contains_key(&key) || PROTOTYPE_NAMES.contains(&key.as_str()) {
                return Err(invalid(format!("claim {key:?} conflicts with the payload")));
            }
            if claims.contains_key(&key) {
                return Err(invalid(format!("claim {key:?} is disclosed twice")));
            }
            let value = self.value(&value, nested || !key.is_empty(), depth + 1)?;
            claims.insert(key, value);
        }
        payload.extend(claims);
        Ok(Value::Object(payload))
    }
}

/// Applies `disclosures` to an SD-JWT payload (RFC 9901 section 7.1, step 3) and drops `_sd_alg`.
/// Every disclosure must match exactly one digest; duplicate, unreferenced and conflicting
/// disclosures are rejected.
pub(crate) fn unpack(
    payload: &Map<String, Value>,
    disclosures: &[&str],
) -> Result<Map<String, Value>, Error> {
    let mut map = HashMap::with_capacity(disclosures.len());
    for encoded in disclosures {
        let disclosure = Disclosure::decode(encoded)?;
        if map.insert(digest(encoded), disclosure).is_some() {
            return Err(invalid("duplicate disclosure"));
        }
    }
    let mut payload = payload.clone();
    payload.remove("_sd_alg");
    let mut unpacker = Unpacker {
        map: &map,
        seen: HashSet::new(),
    };
    let Value::Object(claims) = unpacker.object(&payload, false, 0)? else {
        unreachable!("objects unpack to objects");
    };
    if map.keys().any(|d| !unpacker.seen.contains(d)) {
        return Err(invalid("unreferenced disclosure"));
    }
    Ok(claims)
}

/// Applies `disclosures` to `payload_SD` (RFC 9901 section 7.1, step 3): every disclosure must
/// match exactly one digest, and duplicates are rejected. Fields whose disclosure is missing are
/// absent from the result, so it is a full mandate only when every disclosure is given. The
/// top-level `cnf` must be `{ "jwk": agent.cnf.jwk }` and is removed. The payload, the
/// disclosures and the result must stay within the strict JSON profile: safe integers only and
/// at most 32 levels of nesting.
pub fn decode_disclosed(payload_sd: &Value, disclosures: &[String]) -> Result<Value, Error> {
    let payload = payload_sd
        .as_object()
        .ok_or_else(|| invalid("payload is not an object"))?;
    assert_sd_alg(payload)?;
    check(payload_sd)?;
    let disclosures: Vec<&str> = disclosures.iter().map(String::as_str).collect();
    let mut m = unpack(payload, &disclosures)?;
    let cnf = m.remove("cnf").unwrap_or(Value::Null);
    let expected = match m
        .get("agent")
        .and_then(|a| a.get("cnf"))
        .and_then(|c| c.get("jwk"))
    {
        Some(jwk) => json!({ "jwk": jwk }),
        None => json!({}),
    };
    if jcs(&expected)? != jcs(&cnf)? {
        return Err(invalid("cnf differs from agent.cnf"));
    }
    Ok(Value::Object(m))
}
