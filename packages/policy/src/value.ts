import type { Json } from "@keelson/core";

/** The largest integer JSON numbers carry exactly, `2^53 - 1`. */
export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export type JsonObject = { [k: string]: Json };

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `v[key]`, or `undefined` when `v` is not an object or has no such own key. */
export function get(v: unknown, key: string): unknown {
  return isObject(v) && Object.hasOwn(v, key) ? v[key] : undefined;
}

/**
 * Orders strings by their UTF-8 bytes, which is code point order. UTF-16 code unit order
 * differs from it only between surrogates and U+E000..U+FFFF.
 */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return rank(x) - rank(y);
  }
  return a.length - b.length;
}

function rank(unit: number): number {
  if (unit < 0xd800) return unit;
  if (unit < 0xe000) return unit + 0x2000;
  return unit - 0x800;
}

/** Sorts strings by [`compareStrings`] and drops repeats. */
export function sortedSet(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

/**
 * Carries every number that is not a safe integer as its decimal string, so the value always has
 * a JCS form. Cedar then rejects the string where it expects a `Long`.
 */
export function safe(value: unknown): Json {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return value;
    return Number.isInteger(value) ? BigInt(value).toString() : String(value);
  }
  if (typeof value === "bigint") {
    return value >= -MAX_SAFE_INTEGER && value <= MAX_SAFE_INTEGER ? Number(value) : String(value);
  }
  if (Array.isArray(value)) return value.map(safe);
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = safe(v);
    return out;
  }
  return value as Json;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** Lowercase hex. */
export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b];
  return out;
}
