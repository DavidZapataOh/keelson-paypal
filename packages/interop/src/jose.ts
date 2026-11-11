import { sha256 } from "@noble/hashes/sha2.js";
import { base64url, compactVerify, decodeJwt, decodeProtectedHeader, importJWK } from "jose";
import type { EcPublicJwk } from "./signer.ts";

const encoder = new TextEncoder();

/** base64url of SHA-256 over the US-ASCII bytes of `s`. */
export const b64uSha256 = (s: string | Uint8Array): string =>
  base64url.encode(sha256(typeof s === "string" ? encoder.encode(s) : s));

/** `sd_hash` of a presented SD-JWT, its trailing `~` included (RFC 9901 section 4.3.1). */
export function sdHash(sdJwt: string): string {
  return b64uSha256(sdJwt.slice(0, sdJwt.lastIndexOf("~") + 1));
}

/** The payload of a compact JWS, or of the issuer JWT of an SD-JWT. */
export const jwtPayload = (jwt: string): Record<string, unknown> =>
  decodeJwt(jwt.split("~")[0] as string) as Record<string, unknown>;

/** The `sha-256` hasher `@sd-jwt/core` takes. */
export function sha256Hasher(data: string | ArrayBuffer, alg: string): Uint8Array {
  if (alg !== "sha-256") throw new RangeError(`unsupported _sd_alg ${alg}`);
  return sha256(typeof data === "string" ? encoder.encode(data) : new Uint8Array(data));
}

/** Whether a compact JWS verifies under `jwk` with ES256. */
export async function verifiesWith(jws: string, jwk: object): Promise<boolean> {
  try {
    await compactVerify(jws, await importJWK(jwk as never, "ES256"));
    return true;
  } catch {
    return false;
  }
}

/** Whether a compact JWS verifies under the key in `keys` its `kid` names. */
export async function issuedBy(jws: string, keys: EcPublicJwk[]): Promise<boolean> {
  const { kid } = decodeProtectedHeader(jws);
  const key = keys.find((k) => k.kid === kid);
  return key !== undefined && verifiesWith(jws, key);
}
