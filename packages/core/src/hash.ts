import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { type Json, jcs } from "./jcs.ts";

export { sha256 };

export const DST: {
  readonly mandate: "keelson/mandate/v1";
  readonly mandateChallenge: "keelson/mandate-challenge/v1";
  readonly cart: "keelson/cart/v1";
  readonly evidenceItem: "keelson/evidence-item/v1";
  readonly eval: "keelson/eval/v1";
  readonly alibi: "keelson/alibi/v1";
  readonly verdict: "keelson/verdict/v1";
} = Object.freeze({
  mandate: "keelson/mandate/v1",
  mandateChallenge: "keelson/mandate-challenge/v1",
  cart: "keelson/cart/v1",
  evidenceItem: "keelson/evidence-item/v1",
  eval: "keelson/eval/v1",
  alibi: "keelson/alibi/v1",
  verdict: "keelson/verdict/v1",
});

export type Dst = (typeof DST)[keyof typeof DST];

const encoder = new TextEncoder();

/** Computes `SHA-256(utf8(dst) || 0x00 || utf8(JCS(value)))`. */
export function hashObject(dst: Dst, value: Json): Uint8Array {
  const prefix = encoder.encode(dst);
  const body = encoder.encode(jcs(value));
  const input = new Uint8Array(prefix.length + 1 + body.length);
  input.set(prefix, 0);
  input.set(body, prefix.length + 1);
  return sha256(input);
}

export function toHex(bytes: Uint8Array): `0x${string}` {
  return `0x${bytesToHex(bytes)}`;
}

/** Decodes hex with or without a `0x` prefix. */
export function fromHex(hex: string): Uint8Array {
  return hexToBytes(hex.startsWith("0x") ? hex.slice(2) : hex);
}
