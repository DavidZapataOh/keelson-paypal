import { ANY_ITEM, type Mandate } from "./schema.ts";

export type Color = "green" | "amber" | "gray";

export type FieldId =
  | "total"
  | "mode"
  | "recurrence"
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

/** Fields that zkTLS evidence can prove. */
export type ZkTlsField = Extract<FieldId, "category" | "variant" | "return_policy">;

export interface Evidence {
  /** The merchant signed the checkout, so items and prices are attested. */
  merchantSignedCheckout: boolean;
  /** Fields proven with zkTLS. */
  zkTlsFields: ReadonlySet<ZkTlsField>;
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
 * fields that depend on page content are amber until proven; subjective intent is never green.
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
  // A mandate for any item binds no item: its title only describes what the user wants.
  if (anyItem(m)) colors.items = "gray";
  else if (has("checkout.line_items"))
    colors.items = evidence.merchantSignedCheckout ? "green" : "amber";
  if (has("keelson.category")) colors.category = proven("category");
  if (has("keelson.attributes")) colors.variant = proven("variant");
  if (has("keelson.returns")) colors.return_policy = proven("return_policy");
  if (m.intent.subjective.length > 0) colors.subjective = "gray";
  return colors;
}
