import { fromHex, type Json, jcs } from "@keelson/core";
import { LOG_ORIGINS } from "@keelson/log";
import { fromBase64, toBase64url } from "../../b64.ts";
import type { AlibiBundle, AlibiReceipt } from "../../schema.ts";

export const isBundle = (input: AlibiBundle | AlibiReceipt): input is AlibiBundle =>
  "type" in input;

/** The base64url spelling the leaf uses for a `0x` hex value. */
export const b64urlOfHex = (hex: string) => toBase64url(fromHex(hex));

/** The signed checkpoint at the end of a c2sp.org/tlog-proof@v1. */
export function proofCheckpoint(proof: string): string {
  const at = proof.indexOf("\n\n");
  if (at < 0) throw new TypeError("malformed tlog proof");
  return proof.slice(at + 2);
}

/** The origin a signed checkpoint names, if it is one of Keelson's logs. */
export function pinnedOrigin(checkpoint: string): string {
  const origin = checkpoint.slice(0, checkpoint.indexOf("\n"));
  if (!Object.values(LOG_ORIGINS).includes(origin)) {
    throw new Error(`not a Keelson log origin: ${origin}`);
  }
  return origin;
}

export const leafBytesOf = (input: AlibiBundle | AlibiReceipt) => fromBase64(input.leaf);

export const sameJson = (a: unknown, b: unknown) => jcs(a as Json) === jcs(b as Json);

export const UNDISCLOSED = { status: "undisclosed" } as const;
