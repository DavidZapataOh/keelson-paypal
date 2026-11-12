import { sha256 } from "@noble/hashes/sha2.js";
import { encode } from "./cbor.ts";

/**
 * The RFC 3161 MessageImprint hash for a `3161-ctt` token (RFC 9921 §3.1): SHA-256 of the
 * CBOR-encoded signature field of the COSE_Sign1.
 */
export function statementImprint(signature: Uint8Array): Uint8Array {
  return sha256(encode(signature));
}
