import { ANY_ITEM, type Mandate } from "./schema.ts";

/**
 * How a field is enforced: green when Keelson checks it, amber when the agent operator answers for
 * it, gray when only the user can judge it.
 */
export type Color = "green" | "amber" | "gray";

/** The fields of a mandate card, in the order the card shows them. */
export const FIELD_IDS = [
  "mode",
  "recurrence",
  "total",
  "currency",
  "budget",
  "merchant",
  "card",
  "deadline",
  "quantity",
  "items",
  "category",
  "variant",
  "return_policy",
  "agent",
  "bond",
  "subjective",
  "summary",
] as const;

/** A field of the mandate card. */
export type FieldId = (typeof FIELD_IDS)[number];

/** Fields that zkTLS evidence can prove. */
export type ZkTlsField = Extract<FieldId, "category" | "variant" | "return_policy">;

/** What the checkout proves, which can raise a field's {@link Color}. */
export interface Evidence {
  /** The merchant signed the checkout, so items and prices are attested. */
  merchantSignedCheckout: boolean;
  /** Fields proven with zkTLS. */
  zkTlsFields: ReadonlySet<ZkTlsField>;
  /** Fields the compiler could not settle from the request; the user answers for them. */
  ambiguous?: ReadonlySet<FieldId>;
}

/** Whether the mandate's line accepts any item. */
export function anyItem(m: Mandate): boolean {
  return m.checkout.constraints.some(
    (c) =>
      c.type === "checkout.line_items" &&
      c.items.some((i) => i.acceptable_items.some((a) => a.id === ANY_ITEM)),
  );
}

/**
 * Trust color of each mandate field the mandate constrains. Fields the TEE checks deterministically are green;
 * fields that depend on page content are amber until proven; subjective intent and fields the
 * compiler could not settle are gray.
 */
export function fieldColors(m: Mandate, evidence: Evidence): Partial<Record<FieldId, Color>> {
  const has = (type: string) => m.checkout.constraints.some((c) => c.type === type);
  const proven = (key: ZkTlsField): Color => (evidence.zkTlsFields.has(key) ? "green" : "amber");
  const colors: Partial<Record<FieldId, Color>> = {
    mode: "green",
    recurrence: "green",
    total: "green",
    currency: "green",
    budget: "green",
    merchant: "green",
    deadline: "green",
    quantity: "green",
    agent: "green",
    bond: "green",
  };
  if (m.payment.rail === "card") colors.card = "green";
  // A mandate for any item binds no item: its title only describes what the user wants.
  if (anyItem(m)) colors.items = "gray";
  else if (has("checkout.line_items"))
    colors.items = evidence.merchantSignedCheckout ? "green" : "amber";
  if (has("keelson.category")) colors.category = proven("category");
  if (has("keelson.attributes")) colors.variant = proven("variant");
  if (has("keelson.returns")) colors.return_policy = proven("return_policy");
  if (m.intent.subjective.length > 0) colors.subjective = "gray";
  // The compiler's restatement of the request: signed, but nothing checks it.
  colors.summary = "gray";
  for (const f of evidence.ambiguous ?? []) if (colors[f]) colors[f] = "gray";
  return colors;
}
