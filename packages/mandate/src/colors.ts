import type { Mandate } from "./schema.ts";

export type Color = "green" | "amber" | "gray";

export type FieldId =
  | "total"
  | "currency"
  | "budget"
  | "merchant"
  | "deadline"
  | "quantity"
  | "agent"
  | "bond"
  | "items"
  | "category"
  | "variant"
  | "return_policy"
  | "subjective";

export interface Evidence {
  /** The merchant signed the checkout, so items and prices are attested. */
  merchantSignedCheckout: boolean;
  /** Fields proven with zkTLS: any of `category`, `variant`, `returns`. */
  zkTlsFields: ReadonlySet<string>;
}

/**
 * Trust color of each mandate field the mandate constrains. Fields the TEE checks deterministically are green;
 * fields that depend on page content are amber until proven; subjective intent is never green.
 */
export function fieldColors(m: Mandate, evidence: Evidence): Partial<Record<FieldId, Color>> {
  const has = (type: string) => m.checkout.constraints.some((c) => c.type === type);
  const proven = (key: string): Color => (evidence.zkTlsFields.has(key) ? "green" : "amber");
  const colors: Partial<Record<FieldId, Color>> = {
    total: "green",
    currency: "green",
    budget: "green",
    merchant: "green",
    deadline: "green",
    quantity: "green",
    agent: "green",
    bond: "green",
  };
  if (has("checkout.line_items"))
    colors.items = evidence.merchantSignedCheckout ? "green" : "amber";
  if (has("keelson.category")) colors.category = proven("category");
  if (has("keelson.attributes")) colors.variant = proven("variant");
  if (has("keelson.returns")) colors.return_policy = proven("returns");
  if (m.intent.subjective.length > 0) colors.subjective = "gray";
  return colors;
}
