import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { TimestampError } from "./errors.ts";
import { pemToDer } from "./pem.ts";
import { TSA_INTERMEDIATES, TSA_PINS, TSA_ROOTS } from "./roots/index.ts";
import { imprintMatches, parseToken } from "./token.ts";
import type { TsaId } from "./tsas.ts";

/** What a verified token proves: this TSA saw the imprint at `genTime`. */
export interface VerifiedStamp {
  tsa: TsaId;
  /** RFC 3339, UTC. */
  genTime: string;
  serial: string;
  policy: string;
  accuracyMs: number | null;
  signer: { subject: string; sha256: string };
}

const ID_KP_TIME_STAMPING = "1.3.6.1.5.5.7.3.8";
const EXT_KEY_USAGE = "2.5.29.37";
const CONTENT_TYPE = "1.2.840.113549.1.9.3";
const MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const SIGNING_CERTIFICATE = "1.2.840.113549.1.9.16.2.12";
const SIGNING_CERTIFICATE_V2 = "1.2.840.113549.1.9.16.2.47";
const KEY_USAGE = "2.5.29.15";
const BASIC_CONSTRAINTS = "2.5.29.19";
const AUTHORITY_KEY_ID = "2.5.29.35";
const SUBJECT_KEY_ID = "2.5.29.14";
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
/** CAs allowed between the signer and the pinned root. */
const MAX_PATH_CAS = 4;
/** SHA-256, SHA-384 and SHA-512 (RFC 5754): the digests accepted for the signature and ESS. */
const STRONG_DIGESTS = new Set([
  "2.16.840.1.101.3.4.2.1",
  "2.16.840.1.101.3.4.2.2",
  "2.16.840.1.101.3.4.2.3",
]);
/** TSAs that only send the SHA-1 `signingCertificate` (v1) attribute. */
const ESS_V1_ONLY = new Set<TsaId>(["freetsa", "sectigo"]);

/**
 * Verifies an RFC 3161 token over a SHA-256 imprint against pinned TSA roots, at the token's own
 * `genTime`: message imprint, CMS signature (RFC 5652 §5.4–5.6), chain, the signer's critical
 * `id-kp-timeStamping` (RFC 3161 §2.3) and its ESS signing-certificate binding (RFC 5816).
 */
export async function verifyTimestamp(
  token: Uint8Array,
  imprint: Uint8Array,
  opts: {
    roots?: Partial<Record<TsaId, Uint8Array[]>>;
    extraCerts?: Uint8Array[];
    now?: Date;
    /** Accept only a token from this TSA. */
    expectedTsa?: TsaId;
  } = {},
): Promise<VerifiedStamp> {
  const parsed = parseToken(token);
  try {
    return await verifyParsed(parsed, imprint, opts);
  } catch (error) {
    if (error instanceof TimestampError) throw error;
    throw new TimestampError("tsa-signature", "the token could not be verified", { cause: error });
  }
}

async function verifyParsed(
  parsed: ReturnType<typeof parseToken>,
  imprint: Uint8Array,
  opts: Parameters<typeof verifyTimestamp>[2] & object,
): Promise<VerifiedStamp> {
  const crypto = pkijs.getCrypto(true);
  const { signedData, tstInfo, genTime } = parsed;

  if (!imprintMatches(tstInfo, imprint)) {
    throw new TimestampError("tsa-imprint", "the token stamps another imprint");
  }
  if (genTime.getTime() > (opts.now ?? new Date()).getTime() + MAX_CLOCK_SKEW_MS) {
    throw new TimestampError("tsa-time", "the token is dated in the future");
  }

  const signerInfo = signedData.signerInfos[0];
  if (signedData.signerInfos.length !== 1 || !signerInfo?.signedAttrs) {
    throw new TimestampError("tsa-parse", "a token has exactly one signer with signed attributes");
  }
  const candidates = [
    ...(signedData.certificates ?? []).filter((c) => c instanceof pkijs.Certificate),
    ...(opts.extraCerts ?? []).map(certificate),
    ...Object.values(TSA_INTERMEDIATES).map((pem) => certificate(pemToDer(pem))),
  ];
  const signer = await findSigner(signerInfo, candidates, crypto);
  if (!signer) throw new TimestampError("tsa-chain", "the signing certificate is missing");

  await verifySignature(signerInfo, signedData, signer, crypto);

  const signerDer = new Uint8Array(signer.toSchema().toBER());
  const signerSha256 = bytesToHex(sha256(signerDer));
  if (genTime < signer.notBefore.value || genTime > signer.notAfter.value) {
    throw new TimestampError("tsa-validity", "genTime is outside the signer's validity");
  }
  const tsa = await validateChain(signer, candidates, genTime, opts, crypto);

  const eku = signer.extensions?.find((e) => e.extnID === EXT_KEY_USAGE);
  const purposes = (eku?.parsedValue as pkijs.ExtKeyUsage | undefined)?.keyPurposes;
  if (!eku?.critical || purposes?.length !== 1 || purposes[0] !== ID_KP_TIME_STAMPING) {
    throw new TimestampError("tsa-eku", "the signer is not a dedicated timestamping certificate");
  }
  if (!keyUsageHas(signer, 0)) {
    throw new TimestampError("tsa-eku", "the signer's key usage lacks digitalSignature");
  }
  await checkSigningCertificate(signerInfo, signerDer, ESS_V1_ONLY.has(tsa), crypto);

  return {
    tsa,
    genTime: genTime.toISOString(),
    serial: parsed.serial,
    policy: parsed.policy,
    accuracyMs: parsed.accuracyMs,
    signer: { subject: distinguishedName(signer.subject), sha256: signerSha256 },
  };
}

function certificate(der: Uint8Array): pkijs.Certificate {
  return pkijs.Certificate.fromBER(der as Uint8Array<ArrayBuffer>);
}

async function findSigner(
  signerInfo: pkijs.SignerInfo,
  certificates: pkijs.Certificate[],
  crypto: pkijs.ICryptoEngine,
): Promise<pkijs.Certificate | undefined> {
  const sid = signerInfo.sid;
  if (sid instanceof pkijs.IssuerAndSerialNumber) {
    return certificates.find(
      (c) => c.issuer.isEqual(sid.issuer) && c.serialNumber.isEqual(sid.serialNumber),
    );
  }
  const keyId = new Uint8Array(sid.valueBlock.valueHexView);
  for (const c of certificates) {
    const spki = c.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView;
    const digest = new Uint8Array(await crypto.digest({ name: "SHA-1" }, spki.slice()));
    if (equal(digest, keyId)) return c;
  }
  return undefined;
}

async function verifySignature(
  signerInfo: pkijs.SignerInfo,
  signedData: pkijs.SignedData,
  signer: pkijs.Certificate,
  crypto: pkijs.ICryptoEngine,
): Promise<void> {
  const attributes = signerInfo.signedAttrs?.attributes ?? [];
  const contentType = attributes.find((a) => a.type === CONTENT_TYPE)?.values[0];
  const messageDigest = attributes.find((a) => a.type === MESSAGE_DIGEST)?.values[0];
  if (
    !(contentType instanceof asn1js.ObjectIdentifier) ||
    contentType.valueBlock.toString() !== pkijs.id_eContentType_TSTInfo ||
    !(messageDigest instanceof asn1js.OctetString)
  ) {
    throw new TimestampError("tsa-signature", "content-type or message-digest is missing");
  }
  const digestOid = signerInfo.digestAlgorithm.algorithmId;
  const hash = crypto.getAlgorithmByOID(digestOid);
  if (!STRONG_DIGESTS.has(digestOid) || !("name" in hash)) {
    throw new TimestampError("tsa-signature", "the signature digest is not SHA-256 or stronger");
  }
  const eContent = signedData.encapContentInfo.eContent?.getValue() ?? new ArrayBuffer(0);
  const digest = new Uint8Array(await crypto.digest(hash.name, eContent));
  let valid = equal(digest, messageDigest.valueBlock.valueHexView);
  if (valid) {
    valid = await crypto
      .verifyWithPublicKey(
        signerInfo.signedAttrs?.encodedValue ?? new ArrayBuffer(0),
        signerInfo.signature,
        signer.subjectPublicKeyInfo,
        signerInfo.signatureAlgorithm,
        hash.name,
      )
      .catch(() => false);
  }
  if (!valid) throw new TimestampError("tsa-signature", "the CMS signature does not verify");
}

/**
 * Builds the path from the signer up to a pinned root itself: issuers matched by name and key
 * identifier, each signature checked, every certificate valid at `genTime`, CAs marked as such,
 * at most {@link MAX_PATH_CAS} CAs, and each certificate tried once, so a cycle ends. The path
 * must also hold the TSA's pinned issuing CA or signer key. Returns the TSA whose root it reaches.
 */
async function validateChain(
  signer: pkijs.Certificate,
  certificates: pkijs.Certificate[],
  at: Date,
  opts: { roots?: Partial<Record<TsaId, Uint8Array[]>>; expectedTsa?: TsaId },
  crypto: pkijs.ICryptoEngine,
): Promise<TsaId> {
  const anchors: [TsaId, pkijs.Certificate][] = (
    opts.roots
      ? Object.entries(opts.roots).flatMap(([tsa, ders]) =>
          (ders ?? []).map((der) => [tsa, certificate(der)] as const),
        )
      : Object.entries(TSA_ROOTS).map(([tsa, pem]) => [tsa, certificate(pemToDer(pem))] as const)
  ).filter(([tsa]) => !opts.expectedTsa || tsa === opts.expectedTsa) as [
    TsaId,
    pkijs.Certificate,
  ][];
  // A cross-certificate for a pinned root's own key (DigiCert sends one) is not a path step.
  const cas = certificates.filter(
    (c) => c !== signer && !anchors.some(([, root]) => sameKey(c, root)),
  );
  const tried = new Set<pkijs.Certificate>([signer]);

  const climb = async (
    cert: pkijs.Certificate,
    path: pkijs.Certificate[],
  ): Promise<{ tsa: TsaId; path: pkijs.Certificate[] } | null> => {
    for (const [tsa, root] of anchors) {
      if (issuedBy(cert, root) && validAt(root, at) && (await signedBy(cert, root))) {
        return { tsa, path };
      }
    }
    if (path.length > MAX_PATH_CAS) return null;
    for (const ca of cas) {
      if (tried.has(ca) || !issuedBy(cert, ca) || !isCa(ca) || !validAt(ca, at)) continue;
      tried.add(ca);
      if (!(await signedBy(cert, ca))) continue;
      const found = await climb(ca, [...path, ca]);
      if (found) return found;
    }
    return null;
  };

  const found = await climb(signer, [signer]);
  if (!found)
    throw new TimestampError("tsa-chain", "the signer does not chain to a pinned TSA root");
  const pins = TSA_PINS[found.tsa];
  const pinned = await Promise.all(found.path.map((c) => spkiSha256(c, crypto)));
  if (!pinned.some((h) => pins.includes(h))) {
    throw new TimestampError("tsa-chain", `the chain does not hold ${found.tsa}'s pinned key`);
  }
  if (opts.expectedTsa && found.tsa !== opts.expectedTsa) {
    throw new TimestampError("tsa-chain", `the token is not from ${opts.expectedTsa}`);
  }
  return found.tsa;
}

function issuedBy(cert: pkijs.Certificate, issuer: pkijs.Certificate): boolean {
  if (!cert.issuer.isEqual(issuer.subject)) return false;
  const aki = (
    cert.extensions?.find((e) => e.extnID === AUTHORITY_KEY_ID)?.parsedValue as
      | pkijs.AuthorityKeyIdentifier
      | undefined
  )?.keyIdentifier?.valueBlock.valueHexView;
  const ski = (
    issuer.extensions?.find((e) => e.extnID === SUBJECT_KEY_ID)?.parsedValue as
      | asn1js.OctetString
      | undefined
  )?.valueBlock.valueHexView;
  return !aki || !ski || equal(aki, ski);
}

async function signedBy(cert: pkijs.Certificate, issuer: pkijs.Certificate): Promise<boolean> {
  return cert.verify(issuer).catch(() => false);
}

function validAt(cert: pkijs.Certificate, at: Date): boolean {
  return cert.notBefore.value <= at && at <= cert.notAfter.value;
}

function isCa(cert: pkijs.Certificate): boolean {
  const bc = cert.extensions?.find((e) => e.extnID === BASIC_CONSTRAINTS)?.parsedValue as
    | pkijs.BasicConstraints
    | undefined;
  const ku = cert.extensions?.some((e) => e.extnID === KEY_USAGE);
  return bc?.cA === true && (!ku || keyUsageHas(cert, 5));
}

/** Whether the certificate has a key usage extension with bit `bit` set (0 = digitalSignature). */
function keyUsageHas(cert: pkijs.Certificate, bit: number): boolean {
  const ku = cert.extensions?.find((e) => e.extnID === KEY_USAGE)?.parsedValue as
    | asn1js.BitString
    | undefined;
  const bytes = ku?.valueBlock.valueHexView;
  return !!bytes && (((bytes[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1) === 1;
}

async function spkiSha256(cert: pkijs.Certificate, crypto: pkijs.ICryptoEngine): Promise<string> {
  const der = cert.subjectPublicKeyInfo.toSchema().toBER();
  return bytesToHex(new Uint8Array(await crypto.digest("SHA-256", der)));
}

/** Checks that the ESS signing-certificate attribute names the signer's certificate. */
async function checkSigningCertificate(
  signerInfo: pkijs.SignerInfo,
  signerDer: Uint8Array<ArrayBuffer>,
  allowV1: boolean,
  crypto: pkijs.ICryptoEngine,
): Promise<void> {
  const attributes = signerInfo.signedAttrs?.attributes ?? [];
  const v2 = attributes.find((a) => a.type === SIGNING_CERTIFICATE_V2);
  const v1 = attributes.find((a) => a.type === SIGNING_CERTIFICATE);
  if (!v2 && !allowV1) {
    throw new TimestampError("tsa-ess-cert", "no SHA-256 signingCertificateV2 attribute");
  }
  try {
    // SigningCertificate(V2) ::= SEQUENCE { certs SEQUENCE OF ESSCertID(v2), policies OPTIONAL }
    const value = (v2 ?? v1)?.values[0] as asn1js.Sequence | undefined;
    const certs = value?.valueBlock.value[0] as asn1js.Sequence | undefined;
    const first = certs?.valueBlock.value[0] as asn1js.Sequence | undefined;
    if (!first) throw new Error("no ESSCertID");
    const fields = first.valueBlock.value;
    let hashName = "SHA-1";
    let certHash = fields[0];
    if (v2) {
      // ESSCertIDv2 ::= SEQUENCE { hashAlgorithm DEFAULT id-sha256, certHash, issuerSerial OPTIONAL }
      hashName = "SHA-256";
      if (fields[0] instanceof asn1js.Sequence) {
        const algorithm = new pkijs.AlgorithmIdentifier({ schema: fields[0] });
        const hash = crypto.getAlgorithmByOID(algorithm.algorithmId);
        if (!STRONG_DIGESTS.has(algorithm.algorithmId) || !("name" in hash)) {
          throw new Error("ESSCertIDv2 hash is not SHA-256 or stronger");
        }
        hashName = hash.name;
        certHash = fields[1];
      }
    }
    if (!(certHash instanceof asn1js.OctetString)) throw new Error("no certHash");
    const digest = new Uint8Array(await crypto.digest(hashName, signerDer));
    if (equal(digest, certHash.valueBlock.valueHexView)) return;
  } catch (error) {
    throw new TimestampError("tsa-ess-cert", "malformed ESS signing-certificate", { cause: error });
  }
  throw new TimestampError("tsa-ess-cert", "the ESS signing-certificate is another certificate");
}

const ATTRIBUTE_NAMES: Record<string, string> = {
  "2.5.4.3": "CN",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
};

function distinguishedName(name: pkijs.RelativeDistinguishedNames): string {
  return name.typesAndValues
    .filter((tv) => ATTRIBUTE_NAMES[tv.type])
    .map((tv) => `${ATTRIBUTE_NAMES[tv.type]}=${tv.value.valueBlock.value}`)
    .join(", ");
}

function sameKey(a: pkijs.Certificate, b: pkijs.Certificate): boolean {
  return (
    a.subject.isEqual(b.subject) &&
    equal(
      a.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView,
      b.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView,
    )
  );
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
