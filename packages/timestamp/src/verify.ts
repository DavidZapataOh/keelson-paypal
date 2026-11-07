import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { TimestampError } from "./errors.ts";
import { pemToDer } from "./pem.ts";
import { TSA_INTERMEDIATES, TSA_ROOTS } from "./roots/index.ts";
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
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

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
  } = {},
): Promise<VerifiedStamp> {
  const crypto = pkijs.getCrypto(true);
  const parsed = parseToken(token);
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
  const tsa = await validateChain(signer, candidates, genTime, opts.roots, crypto);

  const eku = signer.extensions?.find((e) => e.extnID === EXT_KEY_USAGE);
  const purposes = (eku?.parsedValue as pkijs.ExtKeyUsage | undefined)?.keyPurposes;
  if (!eku?.critical || purposes?.length !== 1 || purposes[0] !== ID_KP_TIME_STAMPING) {
    throw new TimestampError("tsa-eku", "the signer is not a dedicated timestamping certificate");
  }
  await checkSigningCertificate(signerInfo, signerDer, crypto);

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
  const hash = crypto.getAlgorithmByOID(signerInfo.digestAlgorithm.algorithmId);
  if (!("name" in hash)) throw new TimestampError("tsa-signature", "unsupported digest algorithm");
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

async function validateChain(
  signer: pkijs.Certificate,
  certificates: pkijs.Certificate[],
  checkDate: Date,
  roots: Partial<Record<TsaId, Uint8Array[]>> | undefined,
  crypto: pkijs.ICryptoEngine,
): Promise<TsaId> {
  const anchors: [string, Uint8Array[]][] = roots
    ? Object.entries(roots).map(([tsa, ders]) => [tsa, ders ?? []])
    : Object.entries(TSA_ROOTS).map(([tsa, pem]) => [tsa, [pemToDer(pem)]]);
  for (const [tsa, ders] of anchors) {
    const trustedCerts = ders.map(certificate);
    // A cross-certificate for a pinned root's own key (DigiCert sends one) is dropped: the pinned
    // root is the trust anchor, and pkijs fails to build a path through both.
    const certs = certificates.filter(
      (c) => c !== signer && !trustedCerts.some((root) => sameKey(c, root)),
    );
    const engine = new pkijs.CertificateChainValidationEngine({
      trustedCerts,
      certs: [...certs, signer],
      checkDate,
    });
    const result = await engine.verify({}, crypto).catch(() => null);
    if (result?.result) return tsa as TsaId;
  }
  throw new TimestampError("tsa-chain", "the signer does not chain to a pinned TSA root");
}

/** Checks that the ESS signing-certificate attribute names the signer's certificate. */
async function checkSigningCertificate(
  signerInfo: pkijs.SignerInfo,
  signerDer: Uint8Array<ArrayBuffer>,
  crypto: pkijs.ICryptoEngine,
): Promise<void> {
  const attributes = signerInfo.signedAttrs?.attributes ?? [];
  const v2 = attributes.find((a) => a.type === SIGNING_CERTIFICATE_V2);
  const v1 = attributes.find((a) => a.type === SIGNING_CERTIFICATE);
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
        if (!("name" in hash)) throw new Error("unsupported ESSCertIDv2 hash");
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
