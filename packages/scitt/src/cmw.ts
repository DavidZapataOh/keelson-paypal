import { ScittFormatError } from "./cbor.ts";

/** The collection type of a purchase's TEE evidence, one record per leg. */
export const TEE_LEGS_COLLECTION = "tag:keelson.finance,2026:tee-legs";
/** The record type of one leg's evidence: its signer binding and attestation document as JSON. */
export const TEE_EVIDENCE_TYPE = "application/vnd.keelson.tee-evidence+json";
/** RFC 9999 §3.1.1: the `evidence` bit. */
const EVIDENCE = 1 << 2;

/** A JSON record CMW: `[type, base64url value, ind]`. */
export type CmwRecord = [type: string, value: string, ind?: number];
export type CmwCollection = { __cmwc_t: string } & Record<string, CmwRecord | string>;

const b64url = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const fail = (message: string): never => {
  throw new ScittFormatError("cmw", message);
};

/** The legs' evidence as an RFC 9999 JSON collection, `tdx` first. */
export function teeCollection(legs: { tdx?: Uint8Array; nitro?: Uint8Array }): CmwCollection {
  const out: CmwCollection = { __cmwc_t: TEE_LEGS_COLLECTION };
  if (legs.tdx) out.tdx = [TEE_EVIDENCE_TYPE, b64url(legs.tdx), EVIDENCE];
  if (legs.nitro) out.nitro = [TEE_EVIDENCE_TYPE, b64url(legs.nitro), EVIDENCE];
  return out;
}

/** Reads a JSON collection of records (RFC 9999 §3.3); nested collections are refused. */
export function readCollection(
  c: unknown,
): Map<string, { type: string; value: Uint8Array; ind: number }> {
  if (c === null || typeof c !== "object" || Array.isArray(c)) return fail("not a JSON collection");
  const { __cmwc_t: type, ...entries } = c as Record<string, unknown>;
  if (typeof type !== "string" || type.length === 0) return fail("no __cmwc_t");
  const out = new Map<string, { type: string; value: Uint8Array; ind: number }>();
  for (const [label, record] of Object.entries(entries)) {
    if (!Array.isArray(record) || record.length !== 3) fail(`${label} is not a record with ind`);
    const [t, v, ind] = record as unknown[];
    if (
      typeof t !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(t)
    ) {
      fail(`${label} has no media type`);
    }
    if (typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v)) fail(`${label} is not base64url`);
    if (!Number.isInteger(ind) || (ind as number) < 1 || (ind as number) > 31) fail(`${label} ind`);
    out.set(label, { type: t as string, value: fromB64url(v as string), ind: ind as number });
  }
  if (out.size === 0) fail("a collection has at least one entry");
  return out;
}
