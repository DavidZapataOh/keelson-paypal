import { p256 } from "@noble/curves/nist.js";
import { bytesToHex, concat, type Hex, keccak256 } from "viem";

/** A passkey assertion as `KeelsonBondVault` takes it (`PasskeyAssertion.Assertion`). */
export interface Assertion {
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
}

/** The base64url fields of a WebAuthn or Secure Payment Confirmation assertion. */
export interface SignedAssertion {
  authenticatorData: string;
  clientDataJSON: string;
  /** DER-encoded ECDSA signature. */
  signature: string;
}

/** A P-256 public key as JWK, with base64url coordinates. */
export interface P256PublicJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
}

const N = p256.Point.CURVE().n;
const fromB64u = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const utf8 = new TextEncoder();

/** Byte offsets, which is what the contract indexes `clientDataJSON` by. */
function indexOf(haystack: Uint8Array, needle: string): number {
  const n = utf8.encode(needle);
  outer: for (let i = 0; i + n.length <= haystack.length; i++) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

function startsWith(haystack: Uint8Array, needle: string, at: number): boolean {
  const n = utf8.encode(needle);
  return at >= 0 && at + n.length <= haystack.length && n.every((b, j) => haystack[at + j] === b);
}

/**
 * Encodes an assertion for the on-chain check: the DER signature as `(r, s)` with `s` in the lower
 * half of the order (`s → N − s`, the same signature, which the P-256 verifier requires), and the
 * positions of `"type":"` and `"challenge":"` in `clientDataJSON` (first occurrence).
 * @throws if `clientDataJSON` has no challenge or its type is neither `webauthn.get` nor `payment.get`.
 */
export function toAssertion(signed: SignedAssertion): Assertion {
  const json = fromB64u(signed.clientDataJSON);
  const typeIndex = indexOf(json, '"type":"');
  if (
    !startsWith(json, '"type":"webauthn.get"', typeIndex) &&
    !startsWith(json, '"type":"payment.get"', typeIndex)
  ) {
    throw new TypeError("clientDataJSON type is neither webauthn.get nor payment.get");
  }
  const challengeIndex = indexOf(json, '"challenge":"');
  if (challengeIndex < 0) throw new TypeError("clientDataJSON has no challenge");
  const { r, s } = p256.Signature.fromBytes(fromB64u(signed.signature), "der");
  return {
    r: word(r),
    s: word(s > N / 2n ? N - s : s),
    challengeIndex: BigInt(challengeIndex),
    typeIndex: BigInt(typeIndex),
    authenticatorData: bytesToHex(fromB64u(signed.authenticatorData)),
    clientDataJSON: new TextDecoder().decode(json),
  };
}

/** The passkey's affine coordinates, as the vault takes them. */
export function passkeyPublicKey(jwk: P256PublicJwk): { qx: Hex; qy: Hex } {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw new TypeError("not a P-256 public key");
  const qx = fromB64u(jwk.x);
  const qy = fromB64u(jwk.y);
  if (qx.length !== 32 || qy.length !== 32) throw new TypeError("P-256 coordinates are 32 bytes");
  return { qx: bytesToHex(qx), qy: bytesToHex(qy) };
}

/** `keccak256(qx ‖ qy)`, the key `CoverageLocked` names. */
export function userKeyHash(qx: Hex, qy: Hex): Hex {
  return keccak256(concat([qx, qy]));
}
