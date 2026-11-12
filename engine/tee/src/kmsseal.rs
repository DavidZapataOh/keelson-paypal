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
    /// The request did not reach KMS.
    Kms(String),
    /// KMS answered with an error.
    KmsRefused(String),
    /// KMS's answer is not EnvelopedData for this key, with RSAES-OAEP and AES-256-CBC.
    Envelope(&'static str),
    /// The attestation or the key could not be made.
    Enclave(String),
}

impl std::fmt::Display for SealError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Kms(e) => write!(f, "kms: {e}"),
            Self::KmsRefused(e) => write!(f, "kms refused: {e}"),
            Self::Envelope(what) => write!(f, "kms answer: {what}"),
            Self::Enclave(e) => write!(f, "enclave: {e}"),
        }
    }
}

impl SealError {
    /// The failing step, without KMS's message or anything of the secret: safe to return to the
    /// parent, which cannot read the enclave's console.
    pub fn class(&self) -> &'static str {
        match self {
            Self::Kms(_) => "kms unreachable",
            Self::KmsRefused(_) => "kms refused the decrypt",
            Self::Envelope(what) => what,
            Self::Enclave(_) => "enclave key or attestation",
        }
    }
}

/// The parent's instance-role session, which may only call `kms:Decrypt` on the key.
#[derive(Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AwsSession {
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
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

const OCTET_STRING: u8 = 0x04;
const CONSTRUCTED: u8 = 0x20;
const CONTEXT_SPECIFIC: u8 = 0x80;
/// Deeper than any EnvelopedData nests.
const MAX_DEPTH: usize = 16;
const NOT_BER: SealError = SealError::Envelope("not BER");

/// Re-encodes BER (X.690) as DER for the `cms` types, which decode DER alone. KMS answers with
/// BER: indefinite lengths, and the encrypted content as a constructed string of OCTET STRING
/// segments (X.690 8.7.3), which DER encodes as one primitive string (X.690 10.2). DER passes
/// through unchanged.
fn ber_to_der(ber: &[u8]) -> Result<Vec<u8>, SealError> {
    let mut input = ber;
    let (tag, content) = ber_element(&mut input, 0)?.ok_or(NOT_BER)?;
    if !input.is_empty() {
        return Err(NOT_BER);
    }
    let mut der = Vec::with_capacity(ber.len());
    write_tlv(&mut der, tag, &content);
    Ok(der)
}

/// Reads one element off `input` as its tag and its DER content, or `None` at an end-of-contents.
fn ber_element(input: &mut &[u8], depth: usize) -> Result<Option<(u8, Vec<u8>)>, SealError> {
    let &[tag, first, ref rest @ ..] = *input else {
        return Err(NOT_BER);
    };
    // CMS uses no tag numbers above 30.
    if tag & 0x1f == 0x1f || depth > MAX_DEPTH {
        return Err(NOT_BER);
    }
    *input = rest;
    if tag == 0 {
        return if first == 0 { Ok(None) } else { Err(NOT_BER) };
    }
    let length = match first {
        0x80 if tag & CONSTRUCTED != 0 => None,
        0..0x80 => Some(usize::from(first)),
        0x81..=0x84 => {
            let (bytes, rest) = input
                .split_at_checked(usize::from(first & 0x7f))
                .ok_or(NOT_BER)?;
            *input = rest;
            Some(bytes.iter().fold(0, |n, b| n << 8 | usize::from(*b)))
        }
        _ => return Err(NOT_BER),
    };
    let mut children = Vec::new();
    match length {
        Some(length) => {
            let (mut body, rest) = input.split_at_checked(length).ok_or(NOT_BER)?;
            *input = rest;
            if tag & CONSTRUCTED == 0 {
                return Ok(Some((tag, body.to_vec())));
            }
            while !body.is_empty() {
                children.push(ber_element(&mut body, depth + 1)?.ok_or(NOT_BER)?);
            }
        }
        None => {
            while let Some(child) = ber_element(input, depth + 1)? {
                children.push(child);
            }
        }
    }
    let string = tag == OCTET_STRING | CONSTRUCTED || tag & 0xc0 == CONTEXT_SPECIFIC;
    if string && !children.is_empty() && children.iter().all(|(t, _)| *t == OCTET_STRING) {
        let joined = children.into_iter().flat_map(|(_, c)| c).collect();
        return Ok(Some((tag & !CONSTRUCTED, joined)));
    }
    let mut content = Vec::new();
    for (t, c) in &children {
        write_tlv(&mut content, *t, c);
    }
    Ok(Some((tag, content)))
}

fn write_tlv(out: &mut Vec<u8>, tag: u8, content: &[u8]) {
    out.push(tag);
    match u8::try_from(content.len()) {
        Ok(n) if n < 0x80 => out.push(n),
        _ => {
            let bytes = content.len().to_be_bytes();
            let skip = bytes.iter().take_while(|b| **b == 0).count();
            out.push(0x80 | (bytes.len() - skip) as u8);
            out.extend_from_slice(&bytes[skip..]);
        }
    }
    out.extend_from_slice(content);
}

/// Opens KMS's `CiphertextForRecipient`: CMS EnvelopedData, in BER, whose one recipient's
/// content key is wrapped for `key` with RSAES-OAEP (SHA-256, MGF1 with SHA-256), and whose
/// content is AES-256-CBC.
pub fn open_envelope(ber: &[u8], key: &PrivateKey) -> Result<Zeroizing<Vec<u8>>, SealError> {
    let der = ber_to_der(ber)?;
    let info = ContentInfo::from_der(&der).map_err(|_| SealError::Envelope("not ContentInfo"))?;
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
        .map_err(|_| SealError::Envelope("content key or IV size"))?;
    decryptor
        .decrypt_padded_vec::<Pkcs7>(ciphertext.as_bytes())
        .map(Zeroizing::new)
        .map_err(|_| SealError::Envelope("content padding"))
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
        return Err(SealError::KmsRefused(format!(
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
        .map_err(|_| SealError::Envelope("CiphertextForRecipient not base64"))?;
    open_envelope(&der, key)
}
