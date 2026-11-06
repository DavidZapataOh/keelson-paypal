import { type PolicyJson, policyToJson, policyToText } from "@cedar-policy/cedar-wasm";
import { type Json, jcs, sha256 } from "@keelson/core";
import { hex, isObject, MAX_SAFE_INTEGER, safe } from "./value.ts";

/** The most extras one evaluation accepts. */
export const MAX_EXTRAS = 16;

/**
 * A constraint a user or operator adds on top of the mandate. Each one only ever denies.
 *
 * This is a closed set: [`parseExtras`] rejects anything else, including a `permit`. Every extra
 * is shown green, with no evidence.
 */
export type Extra =
  /** Denies a cart with a line priced above `minor` per unit. */
  | { type: "max_unit_price"; minor: number }
  /** Denies a cart from merchant `id`. */
  | { type: "deny_merchant"; id: string }
  /** Denies a cart with a line in category `id`. */
  | { type: "deny_category"; id: string }
  /** Denies a cart whose return window is shorter than `min` days. */
  | { type: "require_return_days"; min: number };

const SHAPES = {
  max_unit_price: ["minor", "integer"],
  deny_merchant: ["id", "string"],
  deny_category: ["id", "string"],
  require_return_days: ["min", "integer"],
} as const;

/**
 * Reads a list of extras from JSON, accepting exactly the closed grammar.
 *
 * @throws {TypeError} when an element is not one of the four extras.
 */
export function parseExtras(value: unknown): Extra[] {
  if (!Array.isArray(value)) throw new TypeError("extras: expected array");
  return value.map((x, n) => {
    const shape = isObject(x) && Object.hasOwn(SHAPES, x.type as string) ? x : undefined;
    const [key, kind] = shape ? SHAPES[shape.type as keyof typeof SHAPES] : [];
    const v = shape && key ? shape[key] : undefined;
    const ok =
      shape !== undefined &&
      Object.keys(shape).length === 2 &&
      (kind === "string" ? typeof v === "string" : Number.isInteger(v));
    if (!ok) throw new TypeError(`extras[${n}]: not a known extra`);
    return shape as Extra;
  });
}

/** Why an extra is rejected; `index` is the position of the first rejected extra. */
export type InvalidExtra = "price" | "return_days" | "merchant_id" | "category_id" | "cedar";

/** The first extra that cannot be compiled, or `too_many` past [`MAX_EXTRAS`]. */
export class ExtrasError extends Error {
  constructor(
    readonly index: number,
    readonly reason: InvalidExtra | "too_many",
  ) {
    super(`extra ${index}: ${reason}`);
    this.name = "ExtrasError";
  }
}

/** Unicode general category Cf (format) characters, as of Unicode 17. */
const FORMAT: readonly (readonly [number, number])[] = [
  [0xad, 0xad],
  [0x600, 0x605],
  [0x61c, 0x61c],
  [0x6dd, 0x6dd],
  [0x70f, 0x70f],
  [0x890, 0x891],
  [0x8e2, 0x8e2],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0x110bd, 0x110bd],
  [0x110cd, 0x110cd],
  [0x13430, 0x1343f],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0001, 0xe0001],
  [0xe0020, 0xe007f],
];

const utf8 = new TextEncoder();

/** A mandate merchant `id`: 1 to 128 UTF-8 bytes with no control (Cc) or format (Cf) characters. */
export function isMerchantId(s: string): boolean {
  if (s.length === 0 || !s.isWellFormed() || utf8.encode(s).length > 128) return false;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return false;
    if (FORMAT.some(([lo, hi]) => c >= lo && c <= hi)) return false;
  }
  return true;
}

/** The `@field`, the context attribute read, the comparison and the literal. */
function parts(e: Extra): [string, string, string, Json] {
  switch (e.type) {
    case "max_unit_price":
      return ["total", "max_unit_minor", ">", e.minor];
    case "deny_merchant":
      return ["merchant", "merchant", "==", e.id];
    case "deny_category":
      return ["category", "categories", "contains", e.id];
    case "require_return_days":
      return ["return_policy", "return_days", "<", e.min];
  }
}

function check(e: Extra): InvalidExtra | undefined {
  const integer = (n: number, min: number) =>
    Number.isInteger(n) && n >= min && n <= MAX_SAFE_INTEGER;
  switch (e.type) {
    case "max_unit_price":
      return integer(e.minor, 1) ? undefined : "price";
    case "require_return_days":
      return integer(e.min, 0) ? undefined : "return_days";
    case "deny_merchant":
      return e.id.startsWith("mrc_") && e.id.length > 4 && isMerchantId(e.id)
        ? undefined
        : "merchant_id";
    case "deny_category":
      return /^gpt:[1-9][0-9]{0,9}$/.test(e.id) ? undefined : "category_id";
  }
}

/** The context attribute the policy reads and the constant it compares it with. */
export function binding(e: Extra): [string, Json] {
  const [, attr, , literal] = parts(e);
  return [attr, literal];
}

/** The policy in Cedar's JSON form, so string values are data and never policy syntax. */
function est(e: Extra, id: string) {
  const [field, attr, op, literal] = parts(e);
  return {
    annotations: { id, field, color: "green" },
    effect: "forbid" as const,
    principal: { op: "All" as const },
    action: { op: "==" as const, entity: { type: "Keelson::Action", id: "checkout" } },
    resource: { op: "All" as const },
    conditions: [
      {
        kind: "when" as const,
        body: {
          [op]: { left: { ".": { left: { Var: "context" }, attr } }, right: { Value: literal } },
        },
      },
    ],
  };
}

/**
 * Compiles extras to policies with ids `extra.<n>`, `n` being the extra's position, along with
 * their Cedar JSON form.
 *
 * Each policy is rendered to text and parsed back, and kept only if the parse matches the policy
 * built from its JSON form, so the text is exactly what is evaluated.
 */
export function compile(
  extras: readonly Extra[],
): { id: string; text: string; json: PolicyJson }[] {
  if (extras.length > MAX_EXTRAS) throw new ExtrasError(MAX_EXTRAS, "too_many");
  return extras.map((extra, index) => {
    const reason = check(extra);
    if (reason) throw new ExtrasError(index, reason);
    const id = `extra.${index}`;
    const policy = est(extra, id) as unknown as PolicyJson;
    const built = policyToJson(policy);
    const text = policyToText(policy);
    if (built.type !== "success" || text.type !== "success") throw new ExtrasError(index, "cedar");
    const parsed = policyToJson(text.text);
    const same = (a: PolicyJson, b: PolicyJson) =>
      jcs(a as unknown as Json) === jcs(b as unknown as Json);
    if (parsed.type !== "success" || !same(parsed.json, built.json)) {
      throw new ExtrasError(index, "cedar");
    }
    return { id, text: text.text, json: parsed.json };
  });
}

/**
 * Compiles at most [`MAX_EXTRAS`] extras to `[id, text]` pairs of Cedar `forbid` policies, with
 * ids `extra.<n>`, `n` being the extra's position.
 *
 * Each policy carries `@id`, `@field` and `@color("green")`, and compares one context attribute
 * with a constant.
 *
 * @throws {ExtrasError} for the first extra that is rejected.
 */
export function compileExtras(extras: readonly Extra[]): [string, string][] {
  return compile(extras).map(({ id, text }) => [id, text]);
}

/** `sha256:<hex>` of the JCS form of the extras, in the order given. */
export function extrasHash(extras: readonly Extra[]): string {
  return `sha256:${hex(sha256(utf8.encode(jcs(safe(extras)))))}`;
}
