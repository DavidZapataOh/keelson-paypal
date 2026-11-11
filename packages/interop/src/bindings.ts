import { CURRENCIES, type CurrencyCode } from "@keelson/core";
import type { StatementFacts } from "./facts.ts";

/** A statement fact an export payload may bind. */
export type Fact = keyof StatementFacts;

/** How a fact is stated in a standard's payload. */
export type Transform =
  | "Identity"
  | "Minor"
  | "Major"
  | "UpperCurrency"
  | "LowerCurrency"
  | "UlidOfRequest"
  | "StatusOfDecision";

export interface BindingRow {
  /** RFC 6901 pointer into the payload. */
  pointer: string;
  fact: Fact;
  transform: Transform;
}

/** What the issuer signs for one export profile: its JWS `typ` and the values it binds. */
export interface Profile {
  typ: string;
  rows: BindingRow[];
}

/**
 * The export profiles the issuer signs, by `keelson.profile`: each payload's JWS `typ`, and the
 * payload values that must equal a fact of the purchase's logged statement. Every payload also
 * carries `keelson.statement` and `keelson.facts`.
 */
export const EXPORT_BINDINGS: Record<string, Profile> = {
  "keelson.export/1": { typ: "JWT", rows: [] },
  "ap2.open/1": { typ: "sd+jwt", rows: [] },
  "ap2.checkout_jwt/1": {
    typ: "JWT",
    rows: [
      { pointer: "/totals/0/amount", fact: "amount_minor", transform: "Minor" },
      { pointer: "/currency", fact: "currency", transform: "UpperCurrency" },
    ],
  },
  "ap2.checkout_receipt/1": {
    typ: "JWT",
    rows: [{ pointer: "/status", fact: "decision", transform: "StatusOfDecision" }],
  },
  "acp.allowance/1": {
    typ: "JWT",
    rows: [{ pointer: "/allowance/currency", fact: "currency", transform: "LowerCurrency" }],
  },
  "ap2.payment_receipt/1": {
    typ: "JWT",
    rows: [{ pointer: "/status", fact: "decision", transform: "StatusOfDecision" }],
  },
};

/** Why an export payload cannot be signed. */
export class BindingError extends Error {
  readonly code: "export.facts" | "export.binding" | "export.typ" | "export.statement";

  constructor(code: BindingError["code"], detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "BindingError";
    this.code = code;
  }
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The low 128 bits of a 32-byte request id, as a ULID. */
function ulidOf(requestId: string): string {
  let n = BigInt(requestId) & ((1n << 128n) - 1n);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

function alphaOf(numeric: number): CurrencyCode {
  const code = (Object.keys(CURRENCIES) as CurrencyCode[]).find(
    (c) => CURRENCIES[c].numeric === numeric,
  );
  if (!code) throw new RangeError(`unknown ISO 4217 numeric currency ${numeric}`);
  return code;
}

/** A fact's value as `t` states it. */
export function transform(t: Transform, value: unknown, facts: StatementFacts): unknown {
  switch (t) {
    case "Identity":
    case "Minor":
      return value;
    case "Major": {
      const scale = 10 ** CURRENCIES[alphaOf(facts.currency)].exponent;
      return Number(value) / scale;
    }
    case "UpperCurrency":
      return alphaOf(Number(value));
    case "LowerCurrency":
      return alphaOf(Number(value)).toLowerCase();
    case "UlidOfRequest":
      return ulidOf(String(value));
    case "StatusOfDecision":
      return value === "allow" ? "Success" : "Error";
  }
}

/** The value at an RFC 6901 pointer, or `undefined`. */
export function valueAt(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  let at: unknown = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (at === null || typeof at !== "object" || !Object.hasOwn(at, key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** Deep equality over JSON values. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

/**
 * Throws unless `payload` may be signed with JWS `typ` for the purchase whose logged statement is
 * `statement` with `facts`: the checks leg A runs before it signs an export.
 */
export function checkBinding(
  typ: string,
  payload: Record<string, unknown>,
  facts: StatementFacts,
  statement: string,
): void {
  const profile = valueAt(payload, "/keelson/profile");
  const entry = typeof profile === "string" ? EXPORT_BINDINGS[profile] : undefined;
  if (!entry || entry.typ !== typ)
    throw new BindingError("export.typ", `${String(profile)} as ${typ}`);
  if (valueAt(payload, "/keelson/statement") !== statement)
    throw new BindingError("export.statement");
  if (!same(valueAt(payload, "/keelson/facts"), facts)) throw new BindingError("export.facts");
  for (const row of entry.rows) {
    if (!same(valueAt(payload, row.pointer), transform(row.transform, facts[row.fact], facts))) {
      throw new BindingError("export.binding", row.pointer);
    }
  }
}
