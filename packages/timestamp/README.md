# @keelson/timestamp

RFC 3161 timestamp tokens over a SHA-256 hash: `requestTimestamp` asks a TSA, `verifyTimestamp`
checks a token. The package is isomorphic and runs unchanged in Node and in the browser.

The message imprint is the hash itself (`hashedMessage = hash`, SHA-256), so a token also verifies
with:

```
openssl ts -verify -token_in -in token.der -digest <hash hex> -CAfile <root.pem> [-untrusted <signer.pem>]
```

## TSAs

| Id         | Endpoint                                          | Role                  | Pinned below the root                     |
| ---------- | ------------------------------------------------- | --------------------- | ----------------------------------------- |
| `digicert` | `http://timestamp.digicert.com` (no HTTPS served) | primary               | DigiCert Trusted G4 TimeStamping 2025 CA1 |
| `sigstore` | `https://timestamp.sigstore.dev/api/v1/timestamp` | primary               | the `sigstore-tsa` signer key             |
| `freetsa`  | `https://freetsa.org/tsr`                         | fallback for DigiCert | the FreeTSA signer key                    |
| `sectigo`  | `https://timestamp.sectigo.com/qualified`         | fallback for Sigstore | Sectigo Qualified Time Stamping CA R35    |

Roots and pins live in `src/roots/`, each with its SHA-256 fingerprint and source. A TSA that
rotates its issuing CA or signer key needs a new pin before its tokens verify again.

## What `verifyTimestamp` checks

1. The token parses, holds at most 8 certificates, and its `genTime` is a UTC `GeneralizedTime`.
2. The `TSTInfo` message imprint is SHA-256 over exactly the given hash.
3. The CMS signature (RFC 5652 §5.4–5.6) with a SHA-256, SHA-384 or SHA-512 digest.
4. The path from the signer to a pinned root, built here rather than by a generic path builder:
   issuers matched by name and key identifier, every signature checked, every certificate valid at
   `genTime`, at most 4 CAs, each certificate tried once. The path must hold the TSA's pinned key.
   `expectedTsa` restricts the roots to one TSA.
5. The signer has a critical extended key usage of `id-kp-timeStamping` only, and `digitalSignature`.
6. The ESS signing-certificate attribute names the signer: `signingCertificateV2` with SHA-256 or
   stronger; FreeTSA and Sectigo only send the SHA-1 `signingCertificate`, accepted for them alone.

Tokens are checked at their own `genTime`, not at the time of verification.

## Not checked: revocation

No CRL or OCSP is fetched, so a certificate revoked after `genTime` still verifies. Pinning the
issuing CA or signer key narrows what a compromised key elsewhere in a TSA's hierarchy can sign, and
every hash is stamped by two independent TSAs, so a single revoked TSA does not decide a timestamp.
