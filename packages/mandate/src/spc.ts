import { toPayPalValue } from "@keelson/core";
import type { Mandate } from "./schema.ts";

/** What the browser's Secure Payment Confirmation dialog shows; derived from the mandate. */
export interface SpcDetails {
  payeeName: string;
  payeeOrigin: string;
  total: { currency: string; value: string };
}

/** The payment instrument every mandate is confirmed with. */
export const SPC_INSTRUMENT: { readonly displayName: string; readonly icon: string } = {
  displayName: "Keelson mandate",
  icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' rx='6' fill='%23111'/%3E%3C/svg%3E",
};

/**
 * The SPC dialog details for `m`: Keelson at `payeeOrigin` as the payee and the per-purchase cap,
 * `payment.amount_range.max`, as the total. Signer and verifier both derive them with this.
 */
export function spcDetails(m: Mandate, payeeOrigin: string): SpcDetails {
  const cap = m.payment.constraints.find((c) => c.type === "payment.amount_range");
  if (cap?.type !== "payment.amount_range") throw new RangeError("mandate lacks amount_range");
  return {
    payeeName: "Keelson",
    payeeOrigin,
    total: {
      currency: m.payment.currency,
      value: toPayPalValue({ currency: m.payment.currency, minor: BigInt(cap.max) }),
    },
  };
}
