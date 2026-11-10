/** The amber fields a C2b proof can convict. */
export type AmberField = "size" | "color" | "unit_price" | "returns_free";

/** `amber` of a dispute: what the operator attested about the item, and the court's conviction. */
export interface AmberCase {
  commitment: string;
  attested: {
    url: string;
    sku: string;
    size: string;
    color: string;
    unit_minor: string;
    returns_free: boolean;
  };
  conviction: {
    field: AmberField;
    attested_value: string;
    proven_at: string;
    web_fact_digest: string;
    captured_at: string | null;
    tx_hash: string;
    explorer_url: string;
    proof: { bytes: number; hash: string; public_inputs: string[] } | null;
  } | null;
}

export const AMBER_LABEL: Record<AmberField, string> = {
  size: "Size",
  color: "Color",
  unit_price: "Unit price",
  returns_free: "Free returns",
};

/** An attested value as a person reads it: cents as dollars, the flag as yes or no. */
export function amberValue(field: AmberField, value: string | boolean): string {
  if (field === "unit_price") {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
      Number(value) / 100,
    );
  }
  if (field === "returns_free") return value === true || value === "true" ? "Yes" : "No";
  return String(value);
}
