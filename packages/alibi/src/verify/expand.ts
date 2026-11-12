import { type Json, jcs } from "@keelson/core";
import { LEAF_PREFIX } from "@keelson/log";
import { fromBase64, fromBase64url, toBase64, toBase64url } from "../b64.ts";
import { pointer } from "../codec.ts";
import type { AlibiBundle, AlibiReceipt, AnyAlibi } from "../schema.ts";

/**
 * Pointers no signature or hash covers. PayPal assigns the capture id after the countersign, so
 * only the operator vouches for it.
 */
export const UNBOUND: readonly string[] = ["/paypal/capture_id"];

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type Expanded = Record<string, unknown>;

const leafOf = (body: unknown) => toBase64(encoder.encode(LEAF_PREFIX + jcs(body as Json)));
const disclosureOf = (arr: unknown) => toBase64url(encoder.encode(JSON.stringify(arr)));

function tryExpand<T>(s: string, parse: (s: string) => T, back: (v: T) => string): T | string {
  try {
    const v = parse(s);
    return back(v) === s ? v : s;
  } catch {
    return s;
  }
}

/**
 * A copy of the Alibi with its two encoded parts as JSON: the leaf bytes as their RFC 8785 body
 * and each SD-JWT disclosure as its array. A part that would not re-encode to the same bytes
 * stays encoded.
 */
export function expand(b: AnyAlibi): unknown {
  const e = structuredClone(b) as Expanded;
  if (typeof e.leaf === "string") {
    e.leaf = tryExpand(
      e.leaf,
      (s) => {
        const text = decoder.decode(fromBase64(s));
        if (!text.startsWith(LEAF_PREFIX)) throw new TypeError("no leaf prefix");
        return JSON.parse(text.slice(LEAF_PREFIX.length)) as unknown;
      },
      leafOf,
    );
  }
  const m = e.mandate as { disclosures?: unknown[] } | undefined;
  if (Array.isArray(m?.disclosures)) {
    m.disclosures = m.disclosures.map((d) =>
      typeof d === "string"
        ? tryExpand(d, (s) => JSON.parse(decoder.decode(fromBase64url(s))) as unknown, disclosureOf)
        : d,
    );
  }
  return e;
}

/** The Alibi an expanded copy stands for: `expand`'s inverse. */
export function collapse(e: unknown): AlibiBundle | AlibiReceipt {
  const b = structuredClone(e) as Expanded;
  if (b.leaf !== undefined && typeof b.leaf !== "string") b.leaf = leafOf(b.leaf);
  const m = b.mandate as { disclosures?: unknown[] } | undefined;
  if (Array.isArray(m?.disclosures)) {
    m.disclosures = m.disclosures.map((d) => (typeof d === "string" ? d : disclosureOf(d)));
  }
  return b as unknown as AlibiBundle | AlibiReceipt;
}

/** The pointer of every scalar and empty container in `e`, in document order. */
export function pointers(e: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: PropertyKey[]) => {
    const entries = v !== null && typeof v === "object" ? Object.entries(v) : undefined;
    if (entries?.length) {
      for (const [k, x] of entries) walk(x, [...path, k]);
    } else {
      out.push(pointer(path));
    }
  };
  walk(e, []);
  return out;
}

/** The value at an RFC 6901 pointer, or `undefined`. */
export function valueAt(e: unknown, p: string): unknown {
  if (p === "") return e;
  let v: unknown = e;
  for (const raw of p.slice(1).split("/")) {
    const k = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (v === null || typeof v !== "object" || !Object.hasOwn(v, k)) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

/** Pointers of the scalars that differ between `a` and `b`, or exist in only one of them. */
export function diffPointers(a: unknown, b: unknown): string[] {
  const pa = pointers(a);
  const pb = pointers(b);
  const all = [...new Set([...pa, ...pb])];
  const same = (x: unknown, y: unknown) =>
    x !== null && typeof x === "object"
      ? y !== null && typeof y === "object" && Array.isArray(x) === Array.isArray(y)
      : Object.is(x, y);
  return all.filter((p) => !same(valueAt(a, p), valueAt(b, p)));
}

/** Whether a check that read `reads` read the value at `p`. */
export const reads = (readPointers: readonly string[], p: string) =>
  readPointers.some((r) => r === "" || r === p || p.startsWith(`${r}/`) || r.startsWith(`${p}/`));
