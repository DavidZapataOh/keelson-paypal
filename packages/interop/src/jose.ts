import { sha256 } from "@noble/hashes/sha2.js";
import { base64url, decodeJwt } from "jose";

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
