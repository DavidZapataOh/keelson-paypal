import { CURRENCIES, isUlid } from "@keelson/core";
import { z } from "zod";

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

const merchant = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  website: z.url(),
  paypal_merchant_id: z.string().min(1),
});

const paymentConstraint = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("payment.amount_range"), max: amount, currency }),
  z.strictObject({ type: z.literal("payment.budget"), max: amount, currency }),
  z.strictObject({
    type: z.literal("payment.allowed_payees"),
    allowed: z.array(z.strictObject({ paypal_merchant_id: z.string().min(1) })).min(1),
  }),
  z.strictObject({ type: z.literal("payment.execution_date"), not_after: z.iso.datetime() }),
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
        id: z.string().min(1),
        acceptable_items: z.array(
          z.strictObject({ id: z.string().min(1), title: z.string().optional() }),
        ),
        quantity: z.number().int().positive().safe(),
      }),
    ),
  }),
  z.strictObject({
    type: z.literal("keelson.category"),
    allow: z.array(z.string()).min(1),
    deny: z.array(z.string()),
  }),
  z.strictObject({
    type: z.literal("keelson.attributes"),
    must: z.record(z.string(), z.string()),
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
    sub: z.string().min(1),
    cred: z.strictObject({ id: b64url, rp_id: z.string().min(1), jwk: p256Jwk }),
    app_login_id: z.string().min(1),
  }),
  agent: z.strictObject({
    operator: z.strictObject({ agent_registry: z.string().min(1), agent_id: z.string().min(1) }),
    cnf: z.strictObject({ jwk: p256Jwk.extend({ kid: z.string().min(1) }) }),
    bond: z.strictObject({ vault: z.string().min(1), asset: z.string().min(1), min: amount }),
  }),
  payment: z.strictObject({
    rail: z.literal("paypal"),
    currency,
    constraints: z.array(paymentConstraint),
  }),
  checkout: z.strictObject({ constraints: z.array(checkoutConstraint) }),
  intent: z.strictObject({
    prompt_summary: z.string(),
    prompt_hash: sha256,
    subjective: z.array(z.string()),
  }),
  policy: z.strictObject({
    engine: z.string().min(1),
    version: z.string().min(1),
    policy_set_hash: sha256,
    measurements: z.array(z.string()),
  }),
  consent: z.strictObject({
    terms_hash: sha256,
    instruction_use: z.boolean(),
    responsibility_ack: z.boolean(),
    merchant_policy_ack: z.string().min(1),
    recurrence_ack: z.boolean(),
  }),
  zk: z.strictObject({ commitment: z.string().regex(/^0x[0-9a-f]{64}$/) }),
  risk_data: z.strictObject({ device_fp: z.string(), ip: z.string() }),
});

export type Mandate = z.infer<typeof MandateSchema>;

/** Maximum lifetime of a mandate, in seconds. */
export const MAX_LIFETIME_SECONDS = 30 * 86400;

export class MandateError extends Error {
  readonly field: string;
  readonly reason: string;

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`);
    this.name = "MandateError";
    this.field = field;
    this.reason = reason;
  }
}

const PAYMENT_REQUIRED = [
  "payment.amount_range",
  "payment.budget",
  "payment.allowed_payees",
  "payment.execution_date",
];
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
  requireCounts("payment.constraints", m.payment.constraints, PAYMENT_REQUIRED, []);
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
  return m;
}
