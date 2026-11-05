import { isUlid, toHex } from "@keelson/core";

export type Env = "s" | "p";
export type Kind = "a" | "m";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const B64URL_12 = /^[A-Za-z0-9_-]{16}$/;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CUSTOM_ID = /^ks1\.([sp])([am])\.([^.]{26})\.([^.]{43})$/;
const INVOICE_ID = /^KS1-([^-]{26})-(\d{2})-([^-]{26})$/;
const VERDICT_REF = /^ksv1\.([^.]{26})\.([^.]{16})$/;

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url (RFC 4648 section 5). */
function b64url(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += B64URL[(acc >> bits) & 63];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B64URL[(acc << (6 - bits)) & 63];
  return out;
}

/** Strict decode: rejects wrong length and non-zero trailing bits, so every digest has one spelling. */
function fromB64url(s: string, length: number): Uint8Array | null {
  const out = new Uint8Array(length);
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const c of s) {
    const v = B64URL.indexOf(c);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (n >= length) return null;
      out[n++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  return n === length && acc === 0 ? out : null;
}

function assertDigest(digest: Uint8Array, min: number): void {
  if (digest.length < min) throw new RangeError(`digest must be at least ${min} bytes`);
}

function assertUlid(id: string): void {
  if (!isUlid(id)) throw new TypeError("invalid ulid");
}

/** Encodes 16 bytes as 26 Crockford base32 characters, most significant bits first. */
function base32(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (let i = 25; i >= 0; i--) out += CROCKFORD[Number((n >> BigInt(i * 5)) & 31n)];
  return out;
}

function fromBase32(s: string): Uint8Array | null {
  if (!ULID.test(s)) return null;
  let n = 0n;
  for (const c of s) n = (n << 5n) | BigInt(CROCKFORD.indexOf(c));
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

export interface CustomId {
  env: Env;
  kind: Kind;
  id: string;
  digest: Uint8Array;
}

/** Encodes `ks1.<env><kind>.<ulid>.<b64url(digest)>`, 77 characters. */
export function encodeCustomId({ env, kind, id, digest }: CustomId): string {
  assertUlid(id);
  if (digest.length !== 32) throw new RangeError("digest must be 32 bytes");
  return `ks1.${env}${kind}.${id}.${b64url(digest)}`;
}

export function parseCustomId(s: string): CustomId | null {
  const m = CUSTOM_ID.exec(s);
  if (!m || !isUlid(m[3] as string) || !B64URL_32.test(m[4] as string)) return null;
  const digest = fromB64url(m[4] as string, 32);
  if (!digest) return null;
  return { env: m[1] as Env, kind: m[2] as Kind, id: m[3] as string, digest };
}

/** Encodes `KS1-<ulid>-<seq>-<base32(digest[0..16])>`, 60 characters. */
export function encodeInvoiceId(id: string, seq: number, digest: Uint8Array): string {
  assertUlid(id);
  if (!Number.isInteger(seq) || seq < 0 || seq > 99) throw new RangeError("seq must be 0..99");
  assertDigest(digest, 16);
  return `KS1-${id}-${String(seq).padStart(2, "0")}-${base32(digest.subarray(0, 16))}`;
}

export function parseInvoiceId(
  s: string,
): { id: string; seq: number; digest16: Uint8Array } | null {
  const m = INVOICE_ID.exec(s);
  if (!m || !isUlid(m[1] as string)) return null;
  const digest16 = fromBase32(m[3] as string);
  if (!digest16) return null;
  return { id: m[1] as string, seq: Number(m[2]), digest16 };
}

/** Encodes `ksv1.<ulid>.<b64url(digest[0..12])>`, 48 characters. */
export function encodeVerdictRef(id: string, digest: Uint8Array): string {
  assertUlid(id);
  assertDigest(digest, 12);
  return `ksv1.${id}.${b64url(digest.subarray(0, 12))}`;
}

export function parseVerdictRef(s: string): { id: string; digest12: Uint8Array } | null {
  const m = VERDICT_REF.exec(s);
  if (!m || !isUlid(m[1] as string) || !B64URL_12.test(m[2] as string)) return null;
  const digest12 = fromB64url(m[2] as string, 12);
  return digest12 ? { id: m[1] as string, digest12 } : null;
}

/** First 36 hex characters of the digest, used as `PayPal-Request-Id`. */
export function requestIdFromDigest(countersignDigest: Uint8Array): string {
  return toHex(countersignDigest).slice(2, 38);
}
