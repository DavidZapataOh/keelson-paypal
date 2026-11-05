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
 * Trust color of each mandate field. Fields the TEE checks deterministically are green;
 * fields that depend on page content are amber until proven; subjective intent is never green.
 */
export function fieldColors(_m: Mandate, evidence: Evidence): Record<FieldId, Color> {
  const proven = (key: string): Color => (evidence.zkTlsFields.has(key) ? "green" : "amber");
  return {
    total: "green",
    currency: "green",
    budget: "green",
    merchant: "green",
    deadline: "green",
    quantity: "green",
    agent: "green",
    bond: "green",
    items: evidence.merchantSignedCheckout ? "green" : "amber",
    category: proven("category"),
    variant: proven("variant"),
    return_policy: proven("returns"),
    subjective: "gray",
  };
}
