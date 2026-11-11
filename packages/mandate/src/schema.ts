import { CURRENCIES, isUlid } from "@keelson/core";
import { z } from "zod";
import { CONTROL_OR_FORMAT } from "./generated/unicode.ts";
import { ANY_MERCHANT, MCC_TABLE } from "./mcc.ts";

/**
 * Category bit table, version `v1`. Bit `i` of a category mask stands for `ids[i]`; entries are
 * only ever appended. Ids are Google Product Taxonomy ids (taxonomy version 2021-09-21): the 21
 * top-level categories in taxonomy order, then `gpt:187` (Apparel & Accessories > Shoes).
 */
export const CATEGORY_TABLE: { readonly version: "v1"; readonly ids: readonly string[] } = {
  version: "v1",
  ids: [
    "gpt:1", // Animals & Pet Supplies
    "gpt:166", // Apparel & Accessories
    "gpt:8", // Arts & Entertainment
    "gpt:537", // Baby & Toddler
    "gpt:111", // Business & Industrial
    "gpt:141", // Cameras & Optics
    "gpt:222", // Electronics
    "gpt:412", // Food, Beverages & Tobacco
    "gpt:436", // Furniture
    "gpt:632", // Hardware
    "gpt:469", // Health & Beauty
    "gpt:536", // Home & Garden
    "gpt:5181", // Luggage & Bags
    "gpt:772", // Mature
    "gpt:783", // Media
    "gpt:922", // Office Supplies
    "gpt:5605", // Religious & Ceremonial
    "gpt:2092", // Software
    "gpt:988", // Sporting Goods
    "gpt:1239", // Toys & Games
    "gpt:888", // Vehicles & Parts
    "gpt:187", // Apparel & Accessories > Shoes
  ],
};

const categoryId = z.enum(CATEGORY_TABLE.ids as [string, ...string[]]);

const mcc = z.enum(MCC_TABLE.codes as [string, ...string[]]);

const codePoint = (c: number) => `\\u{${c.toString(16)}}`;
const FORBIDDEN_CHARS = new RegExp(
  `[${CONTROL_OR_FORMAT.map(([lo, hi]) => `${codePoint(lo)}-${codePoint(hi)}`).join("")}]`,
  "u",
);
const utf8 = new TextEncoder();

/**
 * Maximum UTF-8 length, in bytes, of each free-form string. The caps are part of the mandate
 * format and are mirrored by the Rust engine.
 */
export const STRING_LIMITS = {
  /** Short identifiers and names: ids, names, asset, version, attribute keys and `kid`. */
  short: 128,
  /** Titles, attribute values, registries, vaults and similar descriptive text. */
  medium: 256,
  /** `intent.prompt_summary`. */
  summary: 1024,
  /** `website`. */
  url: 2048,
} as const;

/**
 * A non-empty (unless `empty`) well-formed string of at most `max` UTF-8 bytes with no Unicode
 * control (Cc) or format (Cf) characters, so a displayed value cannot hide text, reorder it or
 * break lines.
 */
const text = (max: number, empty = false) =>
  z
    .string()
    .refine((s) => empty || s.length > 0, "too small")
    .refine((s) => s.isWellFormed() && !FORBIDDEN_CHARS.test(s), "control or format characters")
    .refine((s) => utf8.encode(s).length <= max, "too long");

/**
 * Whether `s` is a valid merchant `id`: 1 to 128 UTF-8 bytes of well-formed text with no Unicode
 * control (Cc) or format (Cf) characters.
 */
export function isMerchantId(s: string): boolean {
  return (
    s.length > 0 &&
    s.isWellFormed() &&
    !FORBIDDEN_CHARS.test(s) &&
    utf8.encode(s).length <= STRING_LIMITS.short
  );
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const URL_PATH = /^(?:\/[A-Za-z0-9\-._~!$&'()*+,;=:@/?#%]*)?$/;

/**
 * Whether `s` is `https://`, a lowercase ASCII host name whose last label starts with a letter,
 * and an optional path, with no port or user info: a subset of what every WHATWG URL parser
 * accepts, checked the same way in every language.
 */
function isWebsite(s: string): boolean {
  if (!s.startsWith("https://")) return false;
  const rest = s.slice("https://".length);
  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash);
  const labels = host.split(".");
  return (
    host.length <= 253 &&
    labels.every((l) => LABEL.test(l)) &&
    /^[a-z]/.test(labels.at(-1) as string) &&
    URL_PATH.test(slash < 0 ? "" : rest.slice(slash))
  );
}

/**
 * Whether `s` is a serialized https origin as `URL.origin` writes it: `https://`, a host name as
 * {@link isWebsite} takes it and an optional port other than 443, without leading zeros.
 */
function isHttpsOrigin(s: string): boolean {
  const m = /^https:\/\/([^/:]+)(?::([1-9][0-9]{0,4}))?$/.exec(s);
  const port = m?.[2] === undefined ? undefined : Number(m[2]);
  return (
    m !== null &&
    (port === undefined || (port <= 65_535 && port !== 443)) &&
    isWebsite(`https://${m[1]}`)
  );
}

const amount = z.number().int().nonnegative().safe();
const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
// Unpadded base64url with zero trailing bits: 22 chars decode to 16 bytes, 43 chars to 32 bytes.
const b64url16 = z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/);
const b64url32 = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const currency = z.enum(Object.keys(CURRENCIES) as [keyof typeof CURRENCIES]);

const p256Jwk = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: b64url32,
  y: b64url32,
});

/**
 * A merchant the mandate allows. A `paypal` mandate names it by `website` and
 * `paypal_merchant_id`; a `card` mandate by the merchant category codes and country its card
 * authorizations must carry, and may name its `website`.
 */
const merchant = z.strictObject({
  id: text(STRING_LIMITS.short),
  name: text(STRING_LIMITS.short),
  website: z
    .string()
    .refine(isWebsite, "invalid url")
    .refine((s) => s.length <= STRING_LIMITS.url, "too long")
    .optional(),
  paypal_merchant_id: text(STRING_LIMITS.short).optional(),
  mcc: z.array(mcc).min(1).optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
});

const paymentConstraint = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("payment.amount_range"), max: amount, currency }),
  z.strictObject({ type: z.literal("payment.budget"), max: amount, currency }),
  z.strictObject({
    type: z.literal("payment.allowed_payees"),
    allowed: z.array(z.strictObject({ paypal_merchant_id: text(STRING_LIMITS.short) })).min(1),
  }),
  z.strictObject({ type: z.literal("payment.execution_date"), not_after: z.iso.datetime() }),
  z.strictObject({
    type: z.literal("payment.card_controls"),
    single_use: z.literal(true),
    mcc_table: z.literal(MCC_TABLE.version),
  }),
]);

const checkoutConstraint = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("checkout.allowed_merchants"),
    allowed: z.array(merchant).min(1),
  }),
  z.strictObject({
    type: z.literal("checkout.line_items"),
    items: z.array(
      z.strictObject({
        id: text(STRING_LIMITS.short),
        acceptable_items: z
          .array(
            z.strictObject({
              id: text(STRING_LIMITS.short),
              title: text(STRING_LIMITS.medium, true).optional(),
            }),
          )
          .min(1),
        quantity: z.number().int().positive().safe(),
      }),
    ),
  }),
  z.strictObject({
    type: z.literal("keelson.category"),
    allow: z.array(categoryId).min(1),
    deny: z.array(categoryId),
  }),
  z.strictObject({
    type: z.literal("keelson.attributes"),
    must: z.record(text(STRING_LIMITS.short, true), text(STRING_LIMITS.medium, true)),
  }),
  z.strictObject({
    type: z.literal("keelson.returns"),
    min_days: z.number().int().nonnegative().safe(),
    free: z.boolean(),
  }),
]);

/** Zod schema of a `keelson.mandate.1` payload. Unknown keys and constraint types are rejected. */
export const MandateSchema = z.strictObject({
  v: z.literal("keelson.mandate.1"),
  mid: z.string().refine(isUlid, "not a ULID"),
  iat: z.number().int().nonnegative().safe(),
  nbf: z.number().int().nonnegative().safe(),
  exp: z.number().int().nonnegative().safe(),
  nonce: b64url16,
  mode: z.enum(["immediate", "autonomous"]),
  user: z.strictObject({
    sub: text(STRING_LIMITS.short),
    cred: z.strictObject({ id: b64url, rp_id: text(STRING_LIMITS.short), jwk: p256Jwk }),
    app_login_id: text(STRING_LIMITS.medium),
  }),
  agent: z.strictObject({
    operator: z.strictObject({
      agent_registry: text(STRING_LIMITS.medium),
      agent_id: text(STRING_LIMITS.short),
    }),
    cnf: z.strictObject({ jwk: p256Jwk.extend({ kid: text(STRING_LIMITS.short) }) }),
    bond: z.strictObject({
      vault: text(STRING_LIMITS.medium),
      asset: text(STRING_LIMITS.short),
      min: amount,
    }),
  }),
  payment: z.strictObject({
    rail: z.enum(["paypal", "card"]),
    currency,
    constraints: z.array(paymentConstraint),
  }),
  checkout: z.strictObject({ constraints: z.array(checkoutConstraint) }),
  intent: z.strictObject({
    prompt_summary: text(STRING_LIMITS.summary, true),
    prompt_hash: sha256,
    subjective: z.array(text(STRING_LIMITS.medium, true)),
  }),
  policy: z.strictObject({
    engine: text(STRING_LIMITS.short),
    version: text(STRING_LIMITS.short),
    policy_set_hash: sha256,
    measurements: z.array(text(STRING_LIMITS.medium, true)),
  }),
  consent: z.strictObject({
    terms_hash: sha256,
    instruction_use: z.boolean(),
    responsibility_ack: z.boolean(),
    merchant_policy_ack: text(STRING_LIMITS.short),
    recurrence_ack: z.boolean(),
  }),
  zk: z.strictObject({ commitment: z.string().regex(/^0x[0-9a-f]{64}$/) }),
  risk_data: z.strictObject({
    device_fp: text(STRING_LIMITS.short, true),
    ip: text(STRING_LIMITS.short, true),
  }),
  /**
   * Present when the user signed in Keelson's approval framed by an agent platform: the top-level
   * origin of that page. The passkey assertion must then be cross-origin with this `topOrigin`.
   */
  embed: z
    .strictObject({ top_origin: z.string().refine(isHttpsOrigin, "invalid format") })
    .optional(),
});

/** A `keelson.mandate.1` payload. */
export type Mandate = z.infer<typeof MandateSchema>;

/**
 * The `acceptable_items` id that stands for any SKU. A mandate that uses it has a single line, whose
 * only acceptable item it is, and a `keelson.category` constraint; its `title` describes what the
 * user wants and is not blank.
 */
export const ANY_ITEM = "*";

/** Maximum lifetime of a mandate, in seconds. */
export const MAX_LIFETIME_SECONDS = 30 * 86400;

/** A mandate that fails validation. */
export class MandateError extends Error {
  /** The dotted path of the offending field, `""` for the mandate itself. */
  readonly field: string;
  /** Why the field is rejected. */
  readonly reason: string;

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`);
    this.name = "MandateError";
    this.field = field;
    this.reason = reason;
  }
}

const PAYMENT_REQUIRED = {
  paypal: [
    "payment.amount_range",
    "payment.budget",
    "payment.allowed_payees",
    "payment.execution_date",
  ],
  card: [
    "payment.amount_range",
    "payment.budget",
    "payment.execution_date",
    "payment.card_controls",
  ],
};
/** The payment constraint each rail refuses: the other rail's own. */
const PAYMENT_FORBIDDEN = { paypal: "payment.card_controls", card: "payment.allowed_payees" };
/** The merchant fields each rail requires and refuses. */
const MERCHANT_FIELDS = {
  paypal: { required: ["website", "paypal_merchant_id"], forbidden: ["mcc", "country"] },
  card: { required: ["mcc", "country"], forbidden: ["paypal_merchant_id"] },
} as const;
const CHECKOUT_OPTIONAL = [
  "checkout.line_items",
  "keelson.category",
  "keelson.attributes",
  "keelson.returns",
];

/** Each required type appears exactly once and each optional type at most once. */
function requireCounts(
  field: string,
  constraints: readonly { type: string }[],
  required: readonly string[],
  optional: readonly string[],
): void {
  for (const type of [...required, ...optional]) {
    const n = constraints.filter((c) => c.type === type).length;
    if (n > 1 || (n === 0 && required.includes(type))) {
      throw new MandateError(
        field,
        `expected ${required.includes(type) ? "exactly one" : "at most one"} ${type}`,
      );
    }
  }
}

/** Parses and validates a mandate, throwing a {@link MandateError} naming the offending field. */
export function parseMandate(input: unknown): Mandate {
  const result = MandateSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new MandateError(issue?.path.join(".") ?? "", issue?.message ?? "invalid mandate");
  }
  const m = result.data;
  if (m.nbf < m.iat) throw new MandateError("nbf", "nbf is before iat");
  if (m.nbf > m.exp) throw new MandateError("nbf", "nbf is after exp");
  if (m.exp - m.iat > MAX_LIFETIME_SECONDS) {
    throw new MandateError("exp", "lifetime exceeds 30 days");
  }
  const rail = m.payment.rail;
  requireCounts("payment.constraints", m.payment.constraints, PAYMENT_REQUIRED[rail], []);
  if (m.payment.constraints.some((c) => c.type === PAYMENT_FORBIDDEN[rail])) {
    throw new MandateError(
      "payment.constraints",
      `${PAYMENT_FORBIDDEN[rail]} not allowed for rail ${rail}`,
    );
  }
  requireCounts(
    "checkout.constraints",
    m.checkout.constraints,
    ["checkout.allowed_merchants"],
    CHECKOUT_OPTIONAL,
  );
  m.payment.constraints.forEach((c, i) => {
    if ("currency" in c && c.currency !== m.payment.currency) {
      throw new MandateError(`payment.constraints.${i}.currency`, "differs from payment.currency");
    }
  });
  m.checkout.constraints.forEach((c, i) => {
    if (c.type !== "checkout.allowed_merchants") return;
    const { required, forbidden } = MERCHANT_FIELDS[rail];
    c.allowed.forEach((x, j) => {
      const path = `checkout.constraints.${i}.allowed.${j}`;
      for (const key of required) {
        if (x[key] === undefined)
          throw new MandateError(`${path}.${key}`, `required for rail ${rail}`);
      }
      for (const key of forbidden) {
        if (x[key] !== undefined) {
          throw new MandateError(`${path}.${key}`, `not allowed for rail ${rail}`);
        }
      }
      if (x.id === ANY_MERCHANT && (rail !== "card" || c.allowed.length > 1)) {
        throw new MandateError(
          `${path}.id`,
          "any merchant must be the only merchant of a card mandate",
        );
      }
    });
  });
  m.checkout.constraints.forEach((c, i) => {
    if (c.type !== "checkout.line_items") return;
    let any = false;
    c.items.forEach((line, j) => {
      const path = `checkout.constraints.${i}.items.${j}.acceptable_items`;
      const items = line.acceptable_items;
      if (!items.some((a) => a.id === ANY_ITEM)) return;
      if (items.length > 1) throw new MandateError(path, "any item must be the only item");
      if (!items[0]?.title?.trim()) {
        throw new MandateError(`${path}.0.title`, "required for any item");
      }
      any = true;
    });
    if (!any) return;
    if (c.items.length > 1) {
      throw new MandateError(`checkout.constraints.${i}.items`, "any item must be the only line");
    }
    if (!m.checkout.constraints.some((k) => k.type === "keelson.category")) {
      throw new MandateError("checkout.constraints", "any item requires keelson.category");
    }
  });
  return m;
}
