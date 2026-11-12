//! Leg B's own PayPal credential, sealed to its enclave image with AWS KMS (AWS KMS Developer
//! Guide, "Cryptographic attestation support in AWS KMS"): the enclave asks KMS to decrypt with a
//! `Recipient` attestation document whose public key it alone holds, and KMS answers with the
//! plaintext wrapped for that key in CMS EnvelopedData (RFC 5652). The key policy releases it only
//! to the pinned PCR0, so the parent that relays the request never sees the secret.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use cms::cert::x509::der::{Decode, oid::ObjectIdentifier};
use cms::content_info::ContentInfo;
use cms::enveloped_data::{EnvelopedData, RecipientInfo};
use hmac::{Hmac, KeyInit, Mac};
use rsa::pkcs8::EncodePublicKey;
use rsa::{Oaep, PrivateKey};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::tls_client::{Connect, Exchange, send};

/// AWS KMS's root (Amazon Root CA 1, SHA-256
/// 8ecde6884f3d87b1125ba31ac3fcb13d7016de7f57cc904fe1cb97c6ae98196e): the only one the enclave's
/// KMS client accepts.
const AWS_ROOT: &[u8] = include_bytes!("roots/amazon-root-ca-1.der");
const ENVELOPED_DATA: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.7.3");
const RSAES_OAEP: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.7");
const AES_256_CBC: ObjectIdentifier = ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.1.42");
const MAX_RESPONSE: usize = 64 * 1024;

/// Why the sealed secret could not be opened.
#[derive(Debug)]
pub enum SealError {
    /// The request did not reach KMS or KMS refused it.
    Kms(String),
    /// KMS's answer is not EnvelopedData for this key, with RSAES-OAEP and AES-256-CBC.
    Envelope(&'static str),
    /// The attestation or the key could not be made.
    Enclave(String),
}

impl std::fmt::Display for SealError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Kms(e) => write!(f, "kms: {e}"),
            Self::Envelope(what) => write!(f, "kms answer: {what}"),
            Self::Enclave(e) => write!(f, "enclave: {e}"),
        }
    }
}

/// The parent's instance-role session, which may only call `kms:Decrypt` on the key.
#[derive(Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AwsSession {
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: Zeroizing<String>,
    pub session_token: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes any key");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// The headers of a KMS JSON request signed with AWS Signature Version 4 (header signing, as
/// the AWS SDKs sign KMS calls) at `amz_date` (`YYYYMMDD'T'HHMMSS'Z'`).
pub fn signed_headers(
    session: &AwsSession,
    target: &str,
    body: &[u8],
    amz_date: &str,
) -> Vec<(&'static str, String)> {
    let host = format!("kms.{}.amazonaws.com", session.region);
    let date = &amz_date[..8];
    let content_type = "application/x-amz-json-1.1";
    let names = "content-type;host;x-amz-date;x-amz-security-token;x-amz-target";
    let canonical = format!(
        "POST\n/\n\ncontent-type:{content_type}\nhost:{host}\nx-amz-date:{amz_date}\nx-amz-security-token:{}\nx-amz-target:{target}\n\n{names}\n{}",
        session.session_token,
        hex(&Sha256::digest(body)),
    );
    let scope = format!("{date}/{}/kms/aws4_request", session.region);
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex(&Sha256::digest(canonical.as_bytes()))
    );
    let secret = Zeroizing::new(format!("AWS4{}", session.secret_access_key.as_str()));
    let key = [session.region.as_str(), "kms", "aws4_request"]
        .iter()
        .fold(hmac(secret.as_bytes(), date.as_bytes()), |k, part| {
            hmac(&k, part.as_bytes())
        });
    let signature = hex(&hmac(&key, to_sign.as_bytes()));
    vec![
        ("content-type", content_type.to_owned()),
        ("x-amz-date", amz_date.to_owned()),
        ("x-amz-security-token", session.session_token.clone()),
        ("x-amz-target", target.to_owned()),
        (
            "authorization",
            format!(
                "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={names}, Signature={signature}",
                session.access_key_id
            ),
        ),
    ]
}

/// Opens KMS's `CiphertextForRecipient`: CMS EnvelopedData whose one recipient's content key is
/// wrapped for `key` with RSAES-OAEP (SHA-256), and whose content is AES-256-CBC.
pub fn open_envelope(der: &[u8], key: &PrivateKey) -> Result<Zeroizing<Vec<u8>>, SealError> {
    let info = ContentInfo::from_der(der).map_err(|_| SealError::Envelope("not ContentInfo"))?;
    if info.content_type != ENVELOPED_DATA {
        return Err(SealError::Envelope("not EnvelopedData"));
    }
    let data: EnvelopedData = info
        .content
        .decode_as()
        .map_err(|_| SealError::Envelope("not EnvelopedData"))?;
    let [RecipientInfo::Ktri(recipient)] = data.recip_infos.0.as_slice() else {
        return Err(SealError::Envelope("not one key-transport recipient"));
    };
    if recipient.key_enc_alg.oid != RSAES_OAEP {
        return Err(SealError::Envelope("not RSAES-OAEP"));
    }
    let cek = Zeroizing::new(
        key.decrypt(Oaep::<Sha256>::new(), recipient.enc_key.as_bytes())
            .map_err(|_| SealError::Envelope("the content key is not for this enclave"))?,
    );
    let content = &data.encrypted_content;
    if content.content_enc_alg.oid != AES_256_CBC {
        return Err(SealError::Envelope("not AES-256-CBC"));
    }
    let iv = content
        .content_enc_alg
        .parameters
        .as_ref()
        .and_then(|p| {
            p.decode_as::<cms::cert::x509::der::asn1::OctetString>()
                .ok()
        })
        .ok_or(SealError::Envelope("no IV"))?;
    let ciphertext = content
        .encrypted_content
        .as_ref()
        .ok_or(SealError::Envelope("no content"))?;
    use cbc::cipher::{BlockModeDecrypt, KeyIvInit, block_padding::Pkcs7};
    let decryptor = cbc::Decryptor::<aes::Aes256>::new_from_slices(&cek, iv.as_bytes())
        .map_err(|_| SealError::Envelope("key or IV size"))?;
    decryptor
        .decrypt_padded_vec::<Pkcs7>(ciphertext.as_bytes())
        .map(Zeroizing::new)
        .map_err(|_| SealError::Envelope("padding"))
}

/// The DER `SubjectPublicKeyInfo` of a fresh RSA-2048 key, and the key: what the attestation's
/// `public_key` names.
pub fn recipient_key() -> Result<(PrivateKey, Vec<u8>), SealError> {
    let key = PrivateKey::new(&mut getrandom::SysRng, 2048)
        .map_err(|e| SealError::Enclave(e.to_string()))?;
    let spki = key
        .to_public_key()
        .to_public_key_der()
        .map_err(|e| SealError::Enclave(e.to_string()))?
        .to_vec();
    Ok((key, spki))
}

/// Decrypts `ciphertext` (a KMS `CiphertextBlob`) for this enclave: a KMS `Decrypt` with a
/// `Recipient` holding `attestation` (made over `public_key` of [`recipient_key`]), sent over
/// `connect` with TLS to KMS terminated here, then [`open_envelope`].
pub async fn unseal(
    ciphertext: &[u8],
    session: &AwsSession,
    key: &PrivateKey,
    attestation: &[u8],
    connect: &Connect,
    amz_date: &str,
) -> Result<Zeroizing<Vec<u8>>, SealError> {
    let body = serde_json::json!({
        "CiphertextBlob": STANDARD.encode(ciphertext),
        "Recipient": {
            "AttestationDocument": STANDARD.encode(attestation),
            "KeyEncryptionAlgorithm": "RSAES_OAEP_SHA_256",
        },
    })
    .to_string();
    let headers = signed_headers(session, "TrentService.Decrypt", body.as_bytes(), amz_date);
    let host = format!("kms.{}.amazonaws.com", session.region);
    let exchange = Exchange {
        post: true,
        path: "/",
        headers,
        body: hyper::body::Bytes::from(body),
    };
    let (status, answer) = send(connect, &host, AWS_ROOT, exchange, MAX_RESPONSE)
        .await
        .map_err(SealError::Kms)?;
    if status != 200 {
        return Err(SealError::Kms(format!(
            "{status} {}",
            String::from_utf8_lossy(&answer)
        )));
    }
    #[derive(serde::Deserialize)]
    struct Answer {
        #[serde(rename = "CiphertextForRecipient")]
        ciphertext_for_recipient: String,
    }
    let answer: Answer = serde_json::from_slice(&answer)
        .map_err(|_| SealError::Envelope("no CiphertextForRecipient"))?;
    let der = STANDARD
        .decode(answer.ciphertext_for_recipient)
        .map_err(|_| SealError::Envelope("not base64"))?;
    open_envelope(&der, key)
}
