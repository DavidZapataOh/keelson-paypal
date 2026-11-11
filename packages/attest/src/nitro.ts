import "@abraham/reflection";
import { BasicConstraintsExtension, X509Certificate } from "@peculiar/x509";
import { Decoder, Tag } from "cbor-x";
import { bytesToHex, type Hex } from "viem";
import { AttestError } from "./errors.ts";
import { AWS_NITRO_ROOT_PEM } from "./roots/aws-nitro-root-g1.ts";
import { intersect, type Validity } from "./validity.ts";

export type NitroPcrs = Record<0 | 1 | 2 | 3 | 4 | 8, Hex>;

export interface NitroResult {
  moduleId: string;
  /** Milliseconds since the Unix epoch at which the hypervisor produced the document. */
  timestamp: number;
  digest: "SHA384";
  pcrs: NitroPcrs;
  publicKey: Hex | null;
  userData: Hex | null;
  nonce: Hex | null;
  /** When every certificate of the chain is valid. */
  validity: Validity;
}

const PCR_INDEXES = [0, 1, 2, 3, 4, 8] as const;
const ES384 = -35;
const maps = new Decoder({ mapsAsObjects: false });
const root = new X509Certificate(AWS_NITRO_ROOT_PEM);

const cose = (message: string) => new AttestError("cose", message);
const chain = (message: string, cause?: unknown) =>
  new AttestError("cert_chain", message, { cause });

function bytes(value: unknown, what: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw cose(`${what} is not a byte string`);
  return value;
}

function optionalBytes(payload: Map<unknown, unknown>, key: string): Hex | null {
  const value = payload.get(key);
  return value === undefined || value === null ? null : bytesToHex(bytes(value, key));
}

/** The CBOR encoding of the COSE `Sig_structure` for a COSE_Sign1 (RFC 9052, section 4.4). */
function sigStructure(protectedHeader: Uint8Array, payload: Uint8Array): Uint8Array {
  const head = (major: number, length: number) => {
    if (length < 24) return [major | length];
    if (length < 256) return [major | 24, length];
    if (length < 65536) return [major | 25, length >> 8, length & 255];
    return [major | 26, length >>> 24, (length >> 16) & 255, (length >> 8) & 255, length & 255];
  };
  const context = new TextEncoder().encode("Signature1");
  const parts = [
    Uint8Array.of(0x84),
    Uint8Array.from(head(0x60, context.length)),
    context,
    Uint8Array.from(head(0x40, protectedHeader.length)),
    protectedHeader,
    Uint8Array.of(0x40),
    Uint8Array.from(head(0x40, payload.length)),
    payload,
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function decode(document: Uint8Array) {
  let decoded: unknown;
  try {
    decoded = maps.decode(document);
  } catch (cause) {
    throw new AttestError("cose", "the document is not valid CBOR", { cause });
  }
  const value = decoded instanceof Tag ? (decoded.tag === 18 ? decoded.value : null) : decoded;
  if (!Array.isArray(value) || value.length !== 4) throw cose("not a COSE_Sign1 structure");
  const [protectedHeader, , payload, signature] = value as unknown[];
  const header = maps.decode(bytes(protectedHeader, "protected header")) as unknown;
  if (!(header instanceof Map) || header.get(1) !== ES384) throw cose("algorithm is not ES384");
  const sig = bytes(signature, "signature");
  if (sig.length !== 96) throw cose("signature is not 96 bytes");
  const body = maps.decode(bytes(payload, "payload")) as unknown;
  if (!(body instanceof Map)) throw cose("payload is not a map");
  return {
    protectedHeader: protectedHeader as Uint8Array,
    payload: payload as Uint8Array,
    signature: sig,
    body,
  };
}

function field<T>(body: Map<unknown, unknown>, key: string, type: "string" | "number"): T {
  const value = body.get(key);
  const actual = typeof value === "bigint" ? "number" : typeof value;
  if (actual !== type) throw cose(`${key} is missing or not a ${type}`);
  return (typeof value === "bigint" ? Number(value) : value) as T;
}

function certificate(der: unknown, what: string): X509Certificate {
  try {
    return new X509Certificate(bytes(der, what) as Uint8Array<ArrayBuffer>);
  } catch (cause) {
    throw chain(`${what} is not an X.509 certificate`, cause);
  }
}

const same = (a: ArrayBuffer, b: ArrayBuffer) =>
  a.byteLength === b.byteLength && new Uint8Array(a).every((v, i) => v === new Uint8Array(b)[i]);

/**
 * Checks the chain `cabundle[0]` (the AWS root) to the document certificate: the root is the
 * bundled one, every certificate is signed by its predecessor and valid at the document's
 * timestamp and at `now`. Returns the chain, root first.
 */
async function verifyChain(
  body: Map<unknown, unknown>,
  timestamp: number,
  now: Date,
): Promise<X509Certificate[]> {
  const bundle = body.get("cabundle");
  if (!Array.isArray(bundle) || bundle.length === 0) throw chain("cabundle is missing");
  const certs = [...bundle.map((c, i) => certificate(c, `cabundle[${i}]`))];
  const leaf = certificate(body.get("certificate"), "certificate");
  if (!same(certs[0]?.rawData as ArrayBuffer, root.rawData)) {
    throw chain("cabundle does not start at the AWS Nitro root");
  }
  certs.push(leaf);
  for (const [i, cert] of certs.entries()) {
    for (const at of [new Date(timestamp), now]) {
      if (at < cert.notBefore || at > cert.notAfter) {
        throw chain(`certificate ${i} is not valid at ${at.toISOString()}`);
      }
    }
    if (i === 0) continue;
    const parent = certs[i - 1] as X509Certificate;
    const isCa = parent.getExtension(BasicConstraintsExtension)?.ca === true;
    if (!isCa) throw chain(`certificate ${i - 1} is not a CA`);
    if (cert.issuer !== parent.subject) throw chain(`certificate ${i} was not issued by ${i - 1}`);
    const signed = await cert.verify({ publicKey: parent.publicKey, signatureOnly: true });
    if (!signed) throw chain(`certificate ${i} is not signed by certificate ${i - 1}`);
  }
  return certs;
}

/** An all-zero PCR0 marks an enclave started in debug mode. */
export function isDebugMode(pcrs: NitroPcrs): boolean {
  return /^0x0+$/.test(pcrs[0]);
}

/**
 * Verifies an AWS Nitro attestation document: the COSE_Sign1 signature, the certificate chain
 * up to the bundled AWS root, and that the enclave was not started in debug mode.
 */
export async function verifyNitro(document: Uint8Array, opts: { now: Date }): Promise<NitroResult> {
  const { protectedHeader, payload, signature, body } = decode(document);
  const timestamp = field<number>(body, "timestamp", "number");
  const certs = await verifyChain(body, timestamp, opts.now);
  const leaf = certs[certs.length - 1] as X509Certificate;

  const key = await crypto.subtle.importKey(
    "spki",
    leaf.publicKey.rawData,
    { name: "ECDSA", namedCurve: "P-384" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-384" },
    key,
    signature as Uint8Array<ArrayBuffer>,
    sigStructure(protectedHeader, payload) as Uint8Array<ArrayBuffer>,
  );
  if (!ok) throw new AttestError("signature", "the document signature is invalid");

  if (body.get("digest") !== "SHA384") throw cose("digest is not SHA384");
  const raw = body.get("pcrs");
  if (!(raw instanceof Map)) throw cose("pcrs is missing");
  const pcrs = {} as NitroPcrs;
  for (const index of PCR_INDEXES) {
    const pcr = bytes(raw.get(index), `pcr${index}`);
    if (pcr.length !== 48) throw cose(`pcr${index} is not 48 bytes`);
    pcrs[index] = bytesToHex(pcr);
  }
  if (isDebugMode(pcrs)) throw new AttestError("debug_mode", "the enclave runs in debug mode");

  return {
    moduleId: field<string>(body, "module_id", "string"),
    timestamp,
    digest: "SHA384",
    pcrs,
    publicKey: optionalBytes(body, "public_key"),
    userData: optionalBytes(body, "user_data"),
    nonce: optionalBytes(body, "nonce"),
    validity: intersect(certs.map((c) => [c.notBefore, c.notAfter] as const)),
  };
}
