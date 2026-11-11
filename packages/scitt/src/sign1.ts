import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { Tag } from "cbor2";
import { decodeLoose, decodeStrict, encode, ScittFormatError } from "./cbor.ts";

/** COSE_Sign1 (RFC 9052 §4.2). `payload` is `null` when detached. */
export interface Sign1 {
  protected: Uint8Array;
  unprotected: Map<number, unknown>;
  payload: Uint8Array | null;
  signature: Uint8Array;
}

export const COSE_SIGN1_TAG = 18;
export const ALG_ES256K = -47;
export const ALG_ED25519 = -19;

const empty = new Uint8Array(0);

/** `Sig_structure` for a COSE_Sign1 (RFC 9052 §4.4). */
export function sigStructure(
  protectedBytes: Uint8Array,
  payload: Uint8Array,
  externalAad: Uint8Array = empty,
): Uint8Array {
  return encode(["Signature1", protectedBytes, externalAad, payload]);
}

/**
 * Decodes a tagged COSE_Sign1. `strict` (the default) also requires the deterministic encoding,
 * so one statement has exactly one byte form.
 */
export function decodeSign1(bytes: Uint8Array, opts: { strict?: boolean } = {}): Sign1 {
  const value = opts.strict === false ? decodeLoose(bytes) : decodeStrict(bytes);
  if (!(value instanceof Tag) || value.tag !== COSE_SIGN1_TAG) {
    throw new ScittFormatError("format", "not a tagged COSE_Sign1");
  }
  const body = value.contents;
  if (!Array.isArray(body) || body.length !== 4) {
    throw new ScittFormatError("format", "a COSE_Sign1 is an array of four");
  }
  const [prot, unprot, payload, signature] = body as unknown[];
  if (!(prot instanceof Uint8Array) || !(signature instanceof Uint8Array)) {
    throw new ScittFormatError("format", "protected and signature are byte strings");
  }
  if (!(unprot instanceof Map)) throw new ScittFormatError("format", "unprotected is a map");
  if (opts.strict !== false && prot.length === 1 && prot[0] === 0xa0) {
    throw new ScittFormatError("format", "an empty protected header is a zero-length byte string");
  }
  if (payload !== null && !(payload instanceof Uint8Array)) {
    throw new ScittFormatError("format", "payload is a byte string or nil");
  }
  return { protected: prot, unprotected: unprot as Map<number, unknown>, payload, signature };
}

export function encodeSign1(s: Sign1): Uint8Array {
  return encode(new Tag(COSE_SIGN1_TAG, [s.protected, s.unprotected, s.payload, s.signature]));
}

/** The protected header map. */
export function protectedHeader(s: Sign1): Map<number, unknown> {
  if (s.protected.length === 0) return new Map();
  const value = decodeStrict(s.protected);
  if (!(value instanceof Map)) throw new ScittFormatError("format", "protected is not a map");
  return value as Map<number, unknown>;
}

function payloadOf(s: Sign1, detached?: Uint8Array): Uint8Array {
  const payload = s.payload ?? detached;
  if (!payload) throw new ScittFormatError("format", "detached payload not given");
  if (s.payload && detached) throw new ScittFormatError("format", "payload is not detached");
  return payload;
}

/** The Ethereum address of an uncompressed secp256k1 public key. */
export function addressOf(publicKey: Uint8Array): Uint8Array {
  const point = secp256k1.Point.fromBytes(publicKey).toBytes(false);
  return keccak_256(point.subarray(1)).subarray(12);
}

/**
 * ECDSA over secp256k1 with SHA-256 (ES256K, RFC 8812), low-S only. `key` is a SEC1 public key or
 * a 20-byte address, against which both recovery ids are tried.
 */
export function verifyEs256kMessage(
  message: Uint8Array,
  signature: Uint8Array,
  key: Uint8Array,
): boolean {
  if (signature.length !== 64) return false;
  try {
    if (key.length !== 20) return secp256k1.verify(signature, message, key, { lowS: true });
    const sig = secp256k1.Signature.fromBytes(signature, "compact");
    if (sig.hasHighS()) return false;
    for (const recovery of [0, 1]) {
      const recovered = new Uint8Array(65);
      recovered[0] = recovery;
      recovered.set(signature, 1);
      let pub: Uint8Array;
      try {
        pub = secp256k1.recoverPublicKey(recovered, message);
      } catch {
        continue;
      }
      const address = addressOf(pub);
      if (address.every((b, i) => b === key[i])) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function verifyEd25519Message(
  message: Uint8Array,
  signature: Uint8Array,
  key: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, message, key, { zip215: false });
  } catch {
    return false;
  }
}

export function verifyEs256k(s: Sign1, key: Uint8Array, detached?: Uint8Array): boolean {
  return verifyEs256kMessage(sigStructure(s.protected, payloadOf(s, detached)), s.signature, key);
}

export function verifyEd25519(s: Sign1, key: Uint8Array, detached?: Uint8Array): boolean {
  return verifyEd25519Message(sigStructure(s.protected, payloadOf(s, detached)), s.signature, key);
}
