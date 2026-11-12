import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { type Sign1, sigStructure } from "./sign1.ts";

/** Signs a COSE_Sign1 with ES256K (RFC 6979, low-S). For tests and vectors only. */
export function signEs256k(
  protectedBytes: Uint8Array,
  payload: Uint8Array,
  secretKey: Uint8Array,
  opts: { detached?: boolean; unprotected?: Map<number, unknown> } = {},
): Sign1 {
  const signature = secp256k1.sign(sigStructure(protectedBytes, payload), secretKey, {
    lowS: true,
  });
  return {
    protected: protectedBytes,
    unprotected: opts.unprotected ?? new Map(),
    payload: opts.detached ? null : payload,
    signature,
  };
}

/** Signs a COSE_Sign1 with Ed25519. For tests and vectors only. */
export function signEd25519(
  protectedBytes: Uint8Array,
  payload: Uint8Array,
  secretKey: Uint8Array,
  opts: { detached?: boolean; unprotected?: Map<number, unknown> } = {},
): Sign1 {
  return {
    protected: protectedBytes,
    unprotected: opts.unprotected ?? new Map(),
    payload: opts.detached ? null : payload,
    signature: ed25519.sign(sigStructure(protectedBytes, payload), secretKey),
  };
}
/** The Ed25519 public key of a secret key. For tests and vectors only. */
export function ed25519PublicKey(secretKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secretKey);
}
