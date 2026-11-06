use std::time::{SystemTime, UNIX_EPOCH};

use keelson_core::jcs;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::{Map, Value, json};

use crate::sd::{Disclosure, assert_digests_resolved, assert_sd_alg, digest, unpack};
use crate::{Error, b64, parse_mandate};

/// `typ` of the user credential, an SD-JWT VC.
pub const USER_CREDENTIAL_TYP: &str = "dc+sd-jwt";
/// `typ` of the open mandate, a KB-SD-JWT+KB.
pub const OPEN_MANDATE_TYP: &str = "kb-sd-jwt+kb";
/// `typ` of the closed mandate's Key Binding JWT (RFC 9901 section 4.3).
pub const CLOSED_MANDATE_TYP: &str = "kb+jwt";
/// `aud` of the closed mandate's Key Binding JWT.
pub const CLOSED_MANDATE_AUD: &str = "keelson.finance/countersign";
/// `vct` of the user credential.
pub const USER_CREDENTIAL_VCT: &str = "https://keelson.finance/credentials/user/v1";

/// Claims an SD-JWT VC issuer must not make selectively disclosable
/// (draft-ietf-oauth-sd-jwt-vc, section 3.2.2.2).
const PROTECTED_CLAIMS: [&str; 7] = ["iss", "nbf", "exp", "cnf", "vct", "vct#integrity", "status"];
const RESERVED_NAMES: [&str; 4] = ["_sd", "_sd_alg", "_sd_decoy", "..."];
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

fn invalid(reason: impl Into<String>) -> Error {
    Error::Credential(reason.into())
}

/// A P-256 public key as a JWK (RFC 7518 section 6.2.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Jwk {
    pub x: String,
    pub y: String,
    pub kid: Option<String>,
}

impl Jwk {
    /// Reads `{ "kty": "EC", "crv": "P-256", "x", "y" }` and a string `kid`. Private keys are
    /// rejected.
    pub fn from_value(v: &Value) -> Result<Self, Error> {
        let field = |k: &str| v.get(k).and_then(Value::as_str);
        if field("kty") != Some("EC") || field("crv") != Some("P-256") || v.get("d").is_some() {
            return Err(invalid("not a P-256 public JWK"));
        }
        match (field("x"), field("y")) {
            (Some(x), Some(y)) => Ok(Self {
                x: x.to_owned(),
                y: y.to_owned(),
                kid: field("kid").map(str::to_owned),
            }),
            _ => Err(invalid("not a P-256 public JWK")),
        }
    }

    fn verifying_key(&self) -> Result<VerifyingKey, Error> {
        let (x, y) = (coordinate(&self.x)?, coordinate(&self.y)?);
        let point = [&[0x04][..], &x, &y].concat();
        VerifyingKey::from_sec1_bytes(&point).map_err(|_| invalid("JWK is not a P-256 point"))
    }
}

/// What an open mandate must be bound to (RFC 9901 section 7.3, step 5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenMandateVerifyOptions {
    pub expected_aud: String,
    pub expected_nonce: String,
    /// Current time, in seconds since the epoch.
    pub now: i64,
    /// Clock skew tolerated on `iat`, `nbf` and `exp`, in seconds.
    pub max_skew_sec: i64,
}

/// What a closed mandate must be bound to, on top of its open mandate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedMandateVerifyOptions {
    pub open: OpenMandateVerifyOptions,
    /// The request ULID, signed as `nonce`.
    pub request_id: String,
    /// `sha256:<hex>` of the cart.
    pub cart_hash: String,
}

/// A verified closed mandate.
#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedClosedMandate {
    pub open: VerifiedCredential,
    /// The delegate payload's `cnf.jwk`, which signed the key binding.
    pub agent_jwk: Jwk,
    pub iat: i64,
}

/// A verified credential.
#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedCredential {
    pub header: Map<String, Value>,
    /// The payload as signed, with its `_sd` digests. For an open mandate, the delegate payload
    /// as disclosed.
    pub payload: Value,
    /// The payload with the presented disclosures applied. For an open mandate, the delegate
    /// payload, `cnf` included.
    pub claims: Map<String, Value>,
    /// The passkey assertion of an open mandate, checked for shape only.
    pub user_auth: Option<Value>,
    /// The user credential an open mandate is chained to.
    pub user_credential: Option<Box<VerifiedCredential>>,
}

/// A 32-byte coordinate in canonical unpadded base64url: exactly 43 characters, zero pad bits.
fn coordinate(c: &str) -> Result<[u8; 32], Error> {
    b64::decode_canonical(c)
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| invalid("JWK coordinate is not canonical base64url of 32 bytes"))
}

#[derive(Clone, Copy)]
struct Time {
    now: f64,
    skew: f64,
}

struct Jwt<'a> {
    header: Map<String, Value>,
    payload: Map<String, Value>,
    signing_input: &'a str,
    signature: &'a str,
}

fn decode_jwt(jwt: &str) -> Result<Jwt<'_>, Error> {
    let object = |s: &str| match b64::decode_json(s) {
        Some(Value::Object(o)) => Ok(o),
        _ => Err(invalid("invalid JWT")),
    };
    let (signing_input, signature) = jwt.rsplit_once('.').ok_or_else(|| invalid("invalid JWT"))?;
    let (header, payload) = signing_input
        .split_once('.')
        .filter(|(_, p)| !p.contains('.'))
        .ok_or_else(|| invalid("invalid JWT"))?;
    Ok(Jwt {
        header: object(header)?,
        payload: object(payload)?,
        signing_input,
        signature,
    })
}

impl Jwt<'_> {
    /// ES256 only (RFC 7518 section 3.4), with the signature in its canonical encoding: non-zero
    /// pad bits would give the same signature a second encoding (RFC 4648 section 3.5).
    fn verify(&self, key: &VerifyingKey) -> Result<(), Error> {
        match self.header.get("alg") {
            Some(Value::String(alg)) if alg == "ES256" => {}
            _ => return Err(invalid("alg is not ES256")),
        }
        if self.header.contains_key("crit") {
            return Err(invalid("unsupported critical header parameters"));
        }
        let signature = b64::decode_canonical(self.signature)
            .and_then(|sig| Signature::from_slice(&sig).ok())
            .ok_or_else(|| invalid("invalid JWT signature"))?;
        key.verify(self.signing_input.as_bytes(), &signature)
            .map_err(|_| invalid("invalid JWT signature"))
    }
}

/// Checks `iat`, `nbf` and `exp` where present.
fn validate_times(claims: &Map<String, Value>, time: Time) -> Result<(), Error> {
    let date = |k: &str| match claims.get(k) {
        None => Ok(None),
        Some(Value::Number(n)) => Ok(n.as_f64()),
        Some(_) => Err(invalid(format!("{k} must be a number"))),
    };
    let Time { now, skew } = time;
    if date("iat")?.is_some_and(|iat| iat - skew > now)
        || date("nbf")?.is_some_and(|nbf| nbf - skew > now)
    {
        return Err(invalid("not yet valid"));
    }
    if date("exp")?.is_some_and(|exp| exp + skew <= now) {
        return Err(invalid("expired"));
    }
    Ok(())
}

fn reject_reserved_names(v: &Value) -> Result<(), Error> {
    match v {
        Value::Object(o) => o.iter().try_for_each(|(k, v)| {
            if RESERVED_NAMES.contains(&k.as_str()) {
                return Err(invalid(format!("reserved claim name {k:?}")));
            }
            reject_reserved_names(v)
        }),
        Value::Array(items) => items.iter().try_for_each(reject_reserved_names),
        _ => Ok(()),
    }
}

fn has_selectively_disclosable_parts(v: &Value) -> bool {
    match v {
        Value::Array(items) => items.iter().any(has_selectively_disclosable_parts),
        Value::Object(o) => {
            o.contains_key("_sd")
                || o.contains_key("...")
                || o.values().any(has_selectively_disclosable_parts)
        }
        _ => false,
    }
}

/// Verifies an SD-JWT (RFC 9901 section 7.1) with no key binding and returns the header, the
/// signed payload and the claims with the disclosures applied.
fn verify_sd_jwt(
    jwt: &Jwt<'_>,
    disclosures: &[&str],
    key: &VerifyingKey,
    time: Time,
) -> Result<Map<String, Value>, Error> {
    assert_sd_alg(&jwt.payload)?;
    jwt.verify(key)?;
    let claims = unpack(&jwt.payload, disclosures)?;
    for (k, v) in &claims {
        if RESERVED_NAMES.contains(&k.as_str()) {
            return Err(invalid(format!("reserved claim name {k:?}")));
        }
        reject_reserved_names(v)?;
    }
    validate_times(&claims, time)?;
    Ok(claims)
}

/// The `cnf.jwk` member: a P-256 key with canonical coordinates and no members but `kty`, `crv`,
/// `x`, `y` and a string `kid`.
fn cnf_jwk(cnf: Option<&Value>) -> Result<&Value, Error> {
    let jwk = cnf
        .and_then(|c| c.get("jwk"))
        .filter(|j| j.get("kty") == Some(&json!("EC")) && j.get("crv") == Some(&json!("P-256")))
        .ok_or_else(|| invalid("missing cnf.jwk"))?;
    let members = jwk.as_object().into_iter().flatten();
    if members.into_iter().any(|(k, v)| {
        !matches!(k.as_str(), "kty" | "crv" | "x" | "y") && !(k == "kid" && v.is_string())
    }) {
        return Err(invalid(
            "cnf.jwk has members other than kty, crv, x, y and kid",
        ));
    }
    for c in ["x", "y"] {
        coordinate(jwk.get(c).and_then(Value::as_str).unwrap_or_default())?;
    }
    Ok(jwk)
}

fn verify_user_credential(
    token: &str,
    key: &VerifyingKey,
    time: Time,
) -> Result<VerifiedCredential, Error> {
    let parts: Vec<&str> = token.split('~').collect();
    let Some((&"", [jwt, disclosures @ ..])) = parts.split_last() else {
        return Err(invalid("not an SD-JWT without key binding"));
    };
    if jwt.is_empty() || disclosures.contains(&"") {
        return Err(invalid("not an SD-JWT without key binding"));
    }
    let jwt = decode_jwt(jwt)?;
    let claims = verify_sd_jwt(&jwt, disclosures, key, time)?;
    if claims.get("vct").and_then(Value::as_str) != Some(USER_CREDENTIAL_VCT) {
        return Err(invalid("unexpected vct"));
    }
    for name in PROTECTED_CLAIMS {
        if claims.contains_key(name) && !jwt.payload.contains_key(name) {
            return Err(invalid(format!(
                "protected claim {name} is selectively disclosed"
            )));
        }
        if jwt
            .payload
            .get(name)
            .is_some_and(has_selectively_disclosable_parts)
        {
            return Err(invalid(format!(
                "protected claim {name} is selectively disclosable"
            )));
        }
    }
    // Status lists (draft-ietf-oauth-status-list) are never fetched, so a credential that
    // carries a status cannot be checked.
    if claims.contains_key("status") {
        return Err(invalid("status is not supported"));
    }
    if jwt.header.get("typ").and_then(Value::as_str) != Some(USER_CREDENTIAL_TYP) {
        return Err(invalid("unexpected typ"));
    }
    cnf_jwk(claims.get("cnf"))?;
    Ok(VerifiedCredential {
        header: jwt.header,
        payload: Value::Object(jwt.payload),
        claims,
        user_auth: None,
        user_credential: None,
    })
}

fn assert_user_auth(u: Option<&Value>) -> Result<(), Error> {
    for k in ["authenticatorData", "clientDataJSON", "signature"] {
        if !u
            .and_then(|u| u.get(k))
            .and_then(Value::as_str)
            .is_some_and(b64::is_base64url)
        {
            return Err(invalid(format!("user_auth.{k}")));
        }
    }
    Ok(())
}

fn safe_integer(n: i64) -> bool {
    (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&n)
}

/// Verifies a dSD-JWT as in section 6 of draft-ietf-oauth-delegate-sd-jwt-00, with one
/// delegation, and requires every delegated disclosure: the delegate payload must itself be
/// disclosed, and every digest in it, object member or array element, must be resolved.
fn verify_open_mandate(
    token: &str,
    key: &VerifyingKey,
    opts: &OpenMandateVerifyOptions,
) -> Result<VerifiedCredential, Error> {
    if !safe_integer(opts.now) || !safe_integer(opts.max_skew_sec) || opts.max_skew_sec < 0 {
        return Err(invalid("now and max_skew_sec must be whole seconds"));
    }
    let time = Time {
        now: opts.now as f64,
        skew: opts.max_skew_sec as f64,
    };
    let parts: Vec<&str> = token.split('~').collect();
    let split = parts.iter().position(|p| p.is_empty());
    let (Some(split @ 1..), Some(&"")) = (split, parts.last()) else {
        return Err(invalid("not a dSD-JWT"));
    };
    let Some([kb_jwt, disclosures @ .., ""]) = parts.get(split + 1..) else {
        return Err(invalid("not a dSD-JWT"));
    };
    if disclosures.contains(&"") {
        return Err(invalid("not a dSD-JWT"));
    }
    let sd_jwt = format!("{}~", parts[..split].join("~"));
    let user_credential = verify_user_credential(&sd_jwt, key, time)?;
    let holder = Jwk::from_value(cnf_jwk(user_credential.claims.get("cnf"))?)?.verifying_key()?;

    let kb = decode_jwt(kb_jwt)?;
    let claims = verify_sd_jwt(&kb, disclosures, &holder, time)?;
    if kb.header.get("typ").and_then(Value::as_str) != Some(OPEN_MANDATE_TYP) {
        return Err(invalid("unexpected typ"));
    }
    let signed = &kb.payload;
    if !signed.get("iat").is_some_and(Value::is_number)
        || signed.get("sd_hash").and_then(Value::as_str) != Some(&digest(&sd_jwt))
    {
        return Err(invalid("invalid key binding"));
    }
    if signed.get("aud").and_then(Value::as_str) != Some(&opts.expected_aud) {
        return Err(invalid("unexpected aud"));
    }
    if signed.get("nonce").and_then(Value::as_str) != Some(&opts.expected_nonce) {
        return Err(invalid("unexpected nonce"));
    }
    let delegates = match (
        signed.get("delegate_payload"),
        claims.get("delegate_payload"),
    ) {
        (Some(Value::Array(s)), Some(Value::Array(d))) if s.len() == 1 && d.len() == 1 => &d[0],
        _ => return Err(invalid("expected exactly one disclosed delegate payload")),
    };
    let slot = signed["delegate_payload"][0]
        .get("...")
        .and_then(Value::as_str);
    let payload = disclosures
        .iter()
        .find(|d| Some(digest(d).as_str()) == slot)
        .map(|d| Disclosure::decode(d).map(|d| d.value))
        .transpose()?
        .ok_or_else(|| invalid("delegate payload is not disclosed"))?;
    assert_digests_resolved(&Value::Object(signed.clone()), disclosures)?;
    let Value::Object(delegate) = delegates else {
        return Err(invalid("delegate payload is not an object"));
    };
    let mut mandate = delegate.clone();
    let cnf = mandate.remove("cnf");
    cnf_jwk(cnf.as_ref())?;
    validate_times(delegate, time)?;
    let mandate = Value::Object(mandate);
    parse_mandate(&mandate)?;
    let expected = json!({ "jwk": mandate["agent"]["cnf"]["jwk"] });
    if jcs(cnf.as_ref().unwrap_or(&Value::Null))? != jcs(&expected)? {
        return Err(invalid("cnf differs from agent.cnf"));
    }
    assert_user_auth(claims.get("user_auth"))?;
    Ok(VerifiedCredential {
        header: kb.header,
        payload,
        claims: delegate.clone(),
        user_auth: claims.get("user_auth").cloned(),
        user_credential: Some(Box::new(user_credential)),
    })
}

/// Verifies a user credential (RFC 9901 section 7.1) or an open mandate against the issuer's
/// public key. For an open mandate the holder key is taken from the user credential's `cnf`, and
/// the key binding must match `opts`.
///
/// The WebAuthn assertion in an open mandate's `user_auth` is NOT verified here; callers must
/// verify it against `M` and the user's passkey before relying on the mandate.
pub fn verify_credential(
    token: &str,
    expected_typ: &str,
    jwk: &Jwk,
    opts: Option<&OpenMandateVerifyOptions>,
) -> Result<VerifiedCredential, Error> {
    let key = jwk.verifying_key()?;
    if expected_typ == USER_CREDENTIAL_TYP {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| invalid("clock before the epoch"))?
            .as_secs();
        return verify_user_credential(
            token,
            &key,
            Time {
                now: now as f64,
                skew: 0.0,
            },
        );
    }
    if expected_typ != OPEN_MANDATE_TYP {
        return Err(invalid(format!("unexpected typ {expected_typ}")));
    }
    let opts = opts.ok_or_else(|| invalid("open mandate verification needs options"))?;
    verify_open_mandate(token, &key, opts)
}

/// A ULID in its canonical Crockford base32 form.
fn is_ulid(s: &str) -> bool {
    s.len() == 26
        && s.starts_with(|c: char| ('0'..='7').contains(&c))
        && s
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z'))
}

/// `sha256:` and 64 lowercase hex digits.
fn is_cart_hash(s: &str) -> bool {
    s.strip_prefix("sha256:")
        .is_some_and(|h| h.len() == 64 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// Verifies a closed mandate: the open mandate against the issuer's public key and `opts.open`,
/// then the agent's KB-JWT against the delegate payload's `cnf.jwk` (RFC 9901 section 7.3,
/// step 5), bound to `opts.request_id` and `opts.cart_hash` and issued within the skew of `now`.
/// Its `sd_hash` covers the final KB-SD-JWT and its disclosures
/// (draft-ietf-oauth-delegate-sd-jwt-00, section 6).
///
/// A rejected key binding fails with [`Error::Credential`] carrying one of `closed_signature`,
/// `closed_sd_hash`, `closed_aud`, `closed_nonce`, `closed_cart_hash` or `closed_iat`.
///
/// The WebAuthn assertion in the open mandate's `user_auth` is NOT verified here.
pub fn verify_closed_mandate(
    token: &str,
    issuer: &Jwk,
    opts: &ClosedMandateVerifyOptions,
) -> Result<VerifiedClosedMandate, Error> {
    if !is_ulid(&opts.request_id) {
        return Err(invalid("request_id is not a ULID"));
    }
    if !is_cart_hash(&opts.cart_hash) {
        return Err(invalid("cart_hash is not sha256:<hex>"));
    }
    let split = token.rfind('~').map_or(0, |i| i + 1);
    let (open_mandate, kb_jwt) = token.split_at(split);
    let open = verify_open_mandate(open_mandate, &issuer.verifying_key()?, &opts.open)?;
    let agent_jwk = Jwk::from_value(cnf_jwk(open.claims.get("cnf"))?)?;
    let agent = agent_jwk.verifying_key()?;

    let kb = decode_jwt(kb_jwt)
        .ok()
        .filter(|kb| kb.header.get("typ").and_then(Value::as_str) == Some(CLOSED_MANDATE_TYP))
        .filter(|kb| kb.verify(&agent).is_ok())
        .ok_or_else(|| invalid("closed_signature"))?;
    let claim = |k: &str| kb.payload.get(k).and_then(Value::as_str);
    let final_kb_sd_jwt = open_mandate
        .split_once("~~")
        .map_or(open_mandate, |(_, rest)| rest);
    if claim("sd_hash") != Some(&digest(final_kb_sd_jwt)) {
        return Err(invalid("closed_sd_hash"));
    }
    if claim("aud") != Some(CLOSED_MANDATE_AUD) {
        return Err(invalid("closed_aud"));
    }
    if claim("nonce") != Some(&opts.request_id) {
        return Err(invalid("closed_nonce"));
    }
    if claim("cart_hash") != Some(&opts.cart_hash) {
        return Err(invalid("closed_cart_hash"));
    }
    let skew = opts.open.max_skew_sec;
    let iat = kb
        .payload
        .get("iat")
        .and_then(Value::as_i64)
        .filter(|iat| (opts.open.now - skew..=opts.open.now + skew).contains(iat))
        .ok_or_else(|| invalid("closed_iat"))?;
    Ok(VerifiedClosedMandate {
        open,
        agent_jwk,
        iat,
    })
}
