import canonicalize from "canonicalize";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function assertCanonical(value: Json): void {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new TypeError("non-integer number");
    if (Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new TypeError("unsafe integer");
  } else if (typeof value === "string") {
    if (!value.isWellFormed()) throw new TypeError("lone surrogate");
  } else if (Array.isArray(value)) {
    for (const item of value) assertCanonical(item);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertCanonical(key);
      assertCanonical(item);
    }
  }
}

/**
 * Serializes a value as RFC 8785 canonical JSON.
 * Numbers must be safe integers; money and other large values are carried as strings.
 */
export function jcs(value: Json): string {
  assertCanonical(value);
  return canonicalize(value) as string;
}
