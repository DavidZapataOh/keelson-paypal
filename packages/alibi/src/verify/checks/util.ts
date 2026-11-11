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

/** The 32-byte measurement of a `tdx:<hex>` or `nitro:<hex>` measurement id. */
export function measurementHex(id: string): `0x${string}` {
  const m = /^(tdx|nitro):([0-9a-f]{64})$/.exec(id);
  if (!m) throw new TypeError(`malformed measurement id: ${id}`);
  return `0x${m[2]}`;
}

const BIT_PAYPAL = 31n;

/**
 * The reason, when leg A denied the cart on its read of the PayPal hold before any policy ran
 * (`paypal.insufficient`, `paypal.payee`, …): such a trace has no context to replay or compare,
 * its only error is that reason, and the countersignature sets the PayPal bit of its mask.
 */
export function paypalDenial(
  trace: unknown,
  c: { decision: string; failedFieldsMask: string },
): string | undefined {
  const t = trace as {
    decision?: unknown;
    context?: unknown;
    fields?: unknown[];
    fired?: unknown[];
    errors?: unknown[];
  };
  const reason = t.errors?.[0];
  const empty =
    typeof t.context === "object" && t.context !== null && Object.keys(t.context).length === 0;
  return t.decision === "deny" &&
    c.decision === "2" &&
    empty &&
    t.fields?.length === 0 &&
    t.fired?.length === 0 &&
    t.errors?.length === 1 &&
    typeof reason === "string" &&
    reason.startsWith("paypal.") &&
    ((BigInt(c.failedFieldsMask) >> BIT_PAYPAL) & 1n) === 1n
    ? reason
    : undefined;
}
