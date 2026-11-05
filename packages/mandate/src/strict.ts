import { sha256 } from "@keelson/core";
import { base64UrlToUint8Array, uint8ArrayToBase64Url } from "@sd-jwt/core";

/** Deepest nesting of arrays and objects accepted in any credential or disclosure JSON. */
export const MAX_DEPTH = 32;

/**
 * Names every JavaScript object inherits. SD-JWT processing looks digests up in a plain object,
 * so these are refused as digests rather than resolved through the prototype.
 */
const PROTOTYPE_NAMES: ReadonlySet<string> = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
]);

const INTEGER = /^-?(0|[1-9][0-9]*)$/;
const encoder = new TextEncoder();

function assertString(s: string): void {
  if (!s.isWellFormed()) throw new RangeError("string contains a lone surrogate");
}

function assertDigest(d: unknown): void {
  if (typeof d === "string" && PROTOTYPE_NAMES.has(d)) throw new RangeError(`digest ${d}`);
}

function walk(v: unknown, depth: number): void {
  if (typeof v === "string") {
    assertString(v);
    return;
  }
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || Object.is(v, -0))
      throw new RangeError("number is not a safe integer");
    return;
  }
  if (v === null || typeof v !== "object") return;
  if (depth >= MAX_DEPTH) throw new RangeError("JSON nested too deep");
  if (Array.isArray(v)) {
    for (const item of v) walk(item, depth + 1);
    return;
  }
  const o = v as Record<string, unknown>;
  if (Array.isArray(o._sd)) o._sd.forEach(assertDigest);
  if ("..." in o) assertDigest(o["..."]);
  for (const [k, item] of Object.entries(o)) {
    assertString(k);
    walk(item, depth + 1);
  }
}

/**
 * Checks a JSON value: numbers are safe integers other than `-0`, strings and names are
 * well-formed UTF-16, arrays and objects nest at most {@link MAX_DEPTH} deep, and no `_sd` or
 * `...` digest is an `Object.prototype` name.
 */
export function assertStrictJson(v: unknown): void {
  walk(v, 0);
}

/**
 * Parses base64url-encoded UTF-8 JSON under {@link assertStrictJson}, additionally refusing
 * number literals that are not plain integers (`1.0`, `1e2`, `-0`).
 */
export function decodeStrictJson(encoded: string): unknown {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    base64UrlToUint8Array(encoded),
  );
  const reviver = (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === "number" && !INTEGER.test(context?.source ?? "")) {
      throw new RangeError("number is not a safe integer");
    }
    return value;
  };
  const value: unknown = JSON.parse(text, reviver as (k: string, v: unknown) => unknown);
  assertStrictJson(value);
  return value;
}

/** Checks the header and payload of a compact JWS with {@link decodeStrictJson}. */
export function assertStrictJwt(jwt: string): void {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new RangeError("invalid JWT");
  decodeStrictJson(parts[0] as string);
  decodeStrictJson(parts[1] as string);
}

/**
 * Requires every `_sd` digest and every array element placeholder in `payload` and in the
 * disclosed values to belong to one of `disclosures`. Keelson issues no decoy digests, so an
 * unresolved digest is a withheld disclosure.
 */
export function assertDigestsResolved(payload: unknown, disclosures: readonly string[]): void {
  const present = new Set(disclosures.map((d) => uint8ArrayToBase64Url(sha256(encoder.encode(d)))));
  const resolved = (digest: unknown) => {
    if (typeof digest === "string" && !present.has(digest)) {
      throw new RangeError("undisclosed digest");
    }
  };
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item !== null && typeof item === "object" && !Array.isArray(item) && "..." in item) {
          resolved((item as Record<string, unknown>)["..."]);
        }
        walk(item);
      }
      return;
    }
    const o = v as Record<string, unknown>;
    if (Array.isArray(o._sd)) o._sd.forEach(resolved);
    for (const item of Object.values(o)) walk(item);
  };
  walk(payload);
  for (const d of disclosures) walk((decodeStrictJson(d) as unknown[]).at(-1));
}
