import canonicalize from "canonicalize";

const encoder = new TextEncoder();

/**
 * UTF-8 RFC 8785 JSON. Unlike the money-path encoder, finite non-integer numbers are allowed:
 * opacities and AX values are fractional.
 */
export function canonicalBytes(value: unknown): Uint8Array {
  const out = canonicalize(value);
  if (out === undefined || !out.isWellFormed()) throw new TypeError("value is not canonicalizable");
  return encoder.encode(out);
}
