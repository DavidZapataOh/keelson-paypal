import { sha256 } from "@keelson/core";
import { base64url, CompactSign, calculateJwkThumbprint } from "jose";

const encoder = new TextEncoder();

/** A P-256 public key as a JWK (RFC 7518 section 6.2.1). */
export interface EcPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid?: string;
}

/** An ES256 signing key and the `kid` its signatures name. */
export interface Signer {
  key: CryptoKey;
  /** The public key, as verifiers resolve it. */
  jwk: EcPublicJwk;
  kid: string;
}

/**
 * A {@link Signer} for an ES256 private key and its public JWK; `kid` defaults to the public
 * key's RFC 7638 thumbprint.
 */
export async function signerOf(
  key: CryptoKey,
  publicJwk: EcPublicJwk,
  kid?: string,
): Promise<Signer> {
  const { kty, crv, x, y } = publicJwk;
  if (kty !== "EC" || crv !== "P-256") throw new RangeError("not a P-256 key");
  const jwk: EcPublicJwk = { kty, crv, x, y };
  return { key, jwk, kid: kid ?? (await calculateJwkThumbprint(jwk)) };
}

/** A {@link Signer} for a private P-256 JWK, as the key's holder stores it. */
export async function signerFromJwk(privateJwk: JsonWebKey, kid?: string): Promise<Signer> {
  const { kty, crv, x, y, d } = privateJwk;
  if (kty !== "EC" || crv !== "P-256" || !x || !y || !d) {
    throw new RangeError("not a private P-256 JWK");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty, crv, x, y, d },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return signerOf(key, { kty, crv, x, y }, kid ?? (privateJwk as { kid?: string }).kid);
}

/** `B64U(SHA-256(ASCII(s)))`, the digest SD-JWT, AP2 and VI bind with. */
export const hashB64u = (s: string): string => base64url.encode(sha256(encoder.encode(s)));

/** Signs a compact ES256 JWS over the JSON `payload`. */
export async function signJwt(
  header: Record<string, unknown>,
  payload: unknown,
  signer: Signer,
): Promise<string> {
  return new CompactSign(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader({ ...header, alg: "ES256" })
    .sign(signer.key);
}

/** The decoded payload of a compact JWS, unverified. */
export function jwtPayload<T = Record<string, unknown>>(jwt: string): T {
  return JSON.parse(new TextDecoder().decode(base64url.decode(jwt.split(".")[1] ?? "")));
}

/** An SD-JWT disclosure (RFC 9901 section 4.2) and its digest. */
export interface Disclosure {
  encoded: string;
  digest: string;
}

/** Discloses `value`, under `name` when it is an object member, with a fresh 128-bit salt. */
export function disclose(value: unknown, name?: string): Disclosure {
  const salt = base64url.encode(crypto.getRandomValues(new Uint8Array(16)));
  const encoded = base64url.encode(
    JSON.stringify(name === undefined ? [salt, value] : [salt, name, value]),
  );
  return { encoded, digest: hashB64u(encoded) };
}

/** `{"...": digest}`, the array element a disclosure stands for. */
export const ref = (d: Disclosure): { "...": string } => ({ "...": d.digest });

/** `jwt~d1~…~dn~`: an SD-JWT with its disclosures and no key binding. */
export const sdJwt = (jwt: string, disclosures: readonly Disclosure[]): string =>
  `${[jwt, ...disclosures.map((d) => d.encoded)].join("~")}~`;

/**
 * The payload of an SD-JWT with every disclosure it carries applied (RFC 9901 section 7.1,
 * step 3), unverified: `_sd` digests become members and `{"...": digest}` elements values.
 */
export function disclosedPayload<T = Record<string, unknown>>(token: string): T {
  const [jwt = "", ...rest] = token.split("~");
  const byDigest = new Map(
    rest
      .filter((d) => d !== "")
      .map((d) => [
        hashB64u(d),
        JSON.parse(new TextDecoder().decode(base64url.decode(d))) as unknown[],
      ]),
  );
  const resolve = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.flatMap((x) => {
        const digest = (x as { "..."?: string } | null)?.["..."];
        if (digest === undefined) return [resolve(x)];
        const d = byDigest.get(digest);
        return d ? [resolve(d.at(-1))] : [];
      });
    }
    if (v === null || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "_sd" && Array.isArray(x)) {
        for (const digest of x) {
          const d = byDigest.get(digest as string);
          if (d?.length === 3) out[d[1] as string] = resolve(d[2]);
        }
      } else if (k !== "_sd_alg") out[k] = resolve(x);
    }
    return out;
  };
  return resolve(jwtPayload(jwt)) as T;
}
