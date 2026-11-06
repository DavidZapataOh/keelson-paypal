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
 * Whether `v` is an integer as JSON carries it exactly: a safe integer, but not `-0`. The Rust
 * engine reads JSON numbers the same way.
 */
export function isSafeInt(v: unknown): v is number {
  return Number.isSafeInteger(v) && !Object.is(v, -0);
}

/** The objects JSON produces, as opposed to class instances such as `Date`. */
const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (!isObject(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * Writes every number that stands for a safe integer as that integer, and any other as its
 * decimal string as the Rust engine writes it, so the value always has a JCS form. Cedar then
 * rejects the string where it expects a `Long`.
 *
 * Objects are rebuilt with `Object.fromEntries`, so keys such as `__proto__` stay data.
 */
export function safe(value: unknown): Json {
  if (typeof value === "number") {
    if (isSafeInt(value)) return value;
    if (Object.is(value, -0)) return "-0.0";
    return Number.isInteger(value) ? BigInt(value).toString() : String(value);
  }
  if (typeof value === "bigint") {
    return value >= -MAX_SAFE_INTEGER && value <= MAX_SAFE_INTEGER ? Number(value) : String(value);
  }
  if (Array.isArray(value)) return value.map(safe);
  if (isObject(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safe(v)]));
  return value as Json;
}

/**
 * `value` with every lone surrogate in its strings and keys replaced by U+FFFD, so it has a JCS
 * form; `ill.found` is set when one is. Values that are not JSON, such as a `Date`, are kept.
 */
export function wellFormed<T>(value: T, ill: { found: boolean }): T {
  if (typeof value === "string") {
    if (value.isWellFormed()) return value;
    ill.found = true;
    return value.toWellFormed() as T;
  }
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    value.forEach((x, n) => {
      const y = wellFormed(x, ill);
      if (y !== x) {
        out ??= [...value];
        out[n] = y;
      }
    });
    return (out ?? value) as T;
  }
  if (isPlain(value)) {
    let changed = false;
    const entries = Object.entries(value).map(([k, x]) => {
      const key = wellFormed(k, ill);
      const y = wellFormed(x, ill);
      if (key !== k || y !== x) changed = true;
      return [key, y] as const;
    });
    return (changed ? Object.fromEntries(entries) : value) as T;
  }
  return value;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** Lowercase hex. */
export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b];
  return out;
}
