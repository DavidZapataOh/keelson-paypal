//! Issuance of the user credential and the open mandate, mirroring `issueUserCredential` and
//! `issueOpenMandate` claim for claim, so the same salts and `iat` give the same bytes.

use std::collections::HashSet;

use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use serde_json::{Value, json};

use crate::credentials::{assert_user_auth, cnf_jwk, safe_integer};
use crate::sd::digest;
use crate::{Error, Jwk, OPEN_MANDATE_TYP, USER_CREDENTIAL_TYP, USER_CREDENTIAL_VCT, b64};

/// The user's passkey, as bound into the user credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasskeyCredential {
    pub id: String,
    pub rp_id: String,
    pub jwk: Jwk,
}

/// What [`issue_user_credential`] binds into the user credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserCredentialParams {
    pub iss: String,
    pub sub: String,
    pub cred: PasskeyCredential,
    /// Public key of the per-user signing key that issues the user's open mandates.
    pub holder_jwk: Jwk,
}

/// The parts of the WebAuthn assertion over `M`, each base64url.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserAuth {
    pub authenticator_data: String,
    pub client_data_json: String,
    pub signature: String,
}

/// What [`issue_open_mandate`] signs into the open mandate.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenMandateParams {
    /// The user credential, as issued: an SD-JWT with its trailing `~`. Its disclosures are
    /// dropped.
    pub user_credential: String,
    pub payload_sd: Value,
    pub disclosures: Vec<String>,
    pub user_auth: UserAuth,
    pub aud: String,
    pub nonce: String,
}

fn invalid(reason: &str) -> Error {
    Error::Credential(reason.into())
}

fn encode_json(v: &Value) -> String {
    b64::encode(v.to_string().as_bytes())
}

/// A compact ES256 JWS (RFC 7515): RFC 6979 ECDSA over the signing input, as `r ‖ s`.
fn sign_jwt(header: &Value, payload: &Value, key: &SigningKey) -> String {
    let input = format!("{}.{}", encode_json(header), encode_json(payload));
    let signature: Signature = key.sign(input.as_bytes());
    format!("{input}.{}", b64::encode(&signature.to_bytes()))
}

fn check_iat(iat: i64) -> Result<(), Error> {
    if safe_integer(iat) {
        Ok(())
    } else {
        Err(invalid("iat must be whole seconds"))
    }
}

/// Draws disclosure salts and rejects a repeated one, as `@sd-jwt/core` does.
struct Salts<'a> {
    next: &'a mut dyn FnMut() -> [u8; 16],
    seen: HashSet<String>,
}

impl Salts<'_> {
    fn draw(&mut self) -> Result<String, Error> {
        let salt = b64::encode(&(self.next)());
        if !self.seen.insert(salt.clone()) {
            return Err(invalid("duplicate disclosure salt"));
        }
        Ok(salt)
    }
}

/// Issues the user credential: an SD-JWT VC (draft-ietf-oauth-sd-jwt-vc) whose `cnf.jwk` is the
/// holder key that signs the user's open mandates, and whose selectively disclosable `sub` and
/// `cred` are the user and their passkey.
pub fn issue_user_credential(
    p: &UserCredentialParams,
    key: &SigningKey,
    salts: &mut dyn FnMut() -> [u8; 16],
    iat: i64,
) -> Result<String, Error> {
    check_iat(iat)?;
    let mut salts = Salts {
        next: salts,
        seen: HashSet::new(),
    };
    let cred = json!({ "id": p.cred.id, "rp_id": p.cred.rp_id, "jwk": p.cred.jwk.public_value() });
    let disclosures = [
        encode_json(&json!([salts.draw()?, "sub", p.sub])),
        encode_json(&json!([salts.draw()?, "cred", cred])),
    ];
    let mut sd: Vec<String> = disclosures.iter().map(|d| digest(d)).collect();
    sd.sort();
    let payload = json!({
        "iss": p.iss,
        "iat": iat,
        "vct": USER_CREDENTIAL_VCT,
        "cnf": { "jwk": p.holder_jwk.public_value() },
        "_sd": sd,
        "_sd_alg": "sha-256",
    });
    let jwt = sign_jwt(
        &json!({ "typ": USER_CREDENTIAL_TYP, "alg": "ES256" }),
        &payload,
        key,
    );
    Ok(format!("{jwt}~{}~", disclosures.join("~")))
}

/// Issues the open mandate as a dSD-JWT whose KB-SD-JWT+KB, signed by the holder key, carries
/// `payload_sd` as its only delegate payload and the passkey assertion as `user_auth`. The user
/// credential is embedded without its disclosures, so `sub` and `cred` reach no verifier.
///
/// The WebAuthn assertion in `user_auth` is NOT verified here; callers must verify it against
/// `M` and the user's passkey before calling this.
pub fn issue_open_mandate(
    p: &OpenMandateParams,
    key: &SigningKey,
    salts: &mut dyn FnMut() -> [u8; 16],
    iat: i64,
) -> Result<String, Error> {
    check_iat(iat)?;
    if !p.user_credential.ends_with('~') || p.user_credential.ends_with("~~") {
        return Err(invalid(
            "user credential must be an SD-JWT without key binding",
        ));
    }
    let user_credential = &p.user_credential[..=p.user_credential.find('~').expect("ends with ~")];
    cnf_jwk(p.payload_sd.get("cnf"))?;
    let user_auth = json!({
        "authenticatorData": p.user_auth.authenticator_data,
        "clientDataJSON": p.user_auth.client_data_json,
        "signature": p.user_auth.signature,
    });
    assert_user_auth(Some(&user_auth))?;
    let mut salts = Salts {
        next: salts,
        seen: HashSet::new(),
    };
    let delegate = encode_json(&json!([salts.draw()?, p.payload_sd]));
    let payload = json!({
        "delegate_payload": [{ "...": digest(&delegate) }],
        "_sd_alg": "sha-256",
        "iat": iat,
        "aud": p.aud,
        "nonce": p.nonce,
        "sd_hash": digest(user_credential),
        "user_auth": user_auth,
    });
    let kb_jwt = sign_jwt(
        &json!({ "typ": OPEN_MANDATE_TYP, "alg": "ES256" }),
        &payload,
        key,
    );
    let mut out = format!("{user_credential}~{kb_jwt}~{delegate}~");
    for d in &p.disclosures {
        out.push_str(d);
        out.push('~');
    }
    Ok(out)
}
