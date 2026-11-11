import { toPayPalValue } from "@keelson/core";
import type { Mandate } from "./schema.ts";

/** What the browser's Secure Payment Confirmation dialog shows; derived from the mandate. */
export interface SpcDetails {
  payeeName: string;
  payeeOrigin: string;
  total: { currency: string; value: string };
}

/** The WebAuthn RP ID every passkey is scoped to. */
export const RP_ID = "keelson.finance";

/**
 * The origin of the approval page agent platforms frame. A passkey assertion made in it is
 * cross-origin, and its mandate names the top-level page in `embed.top_origin`.
 */
export const EMBED_ORIGIN = "https://api.keelson.finance";

/** The SPC payee: Keelson, at its RP ID domain (SPC requires an https payee origin). */
export const SPC_PAYEE_ORIGIN: string = `https://${RP_ID}`;

/** The payment instrument every mandate is confirmed with. */
export const SPC_INSTRUMENT: { readonly displayName: string; readonly icon: string } = {
  displayName: "Keelson mandate",
  icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' rx='6' fill='%23111'/%3E%3C/svg%3E",
};

/**
 * The SPC dialog details for `m`: Keelson at {@link SPC_PAYEE_ORIGIN} as the payee and the
 * per-purchase cap, `payment.amount_range.max`, as the total. Signer and verifier both derive
 * them with this.
 */
export function spcDetails(m: Mandate): SpcDetails {
  const cap = m.payment.constraints.find((c) => c.type === "payment.amount_range");
  if (cap?.type !== "payment.amount_range") throw new RangeError("mandate lacks amount_range");
  return {
    payeeName: "Keelson",
    payeeOrigin: SPC_PAYEE_ORIGIN,
    total: {
      currency: m.payment.currency,
      value: toPayPalValue({ currency: m.payment.currency, minor: BigInt(cap.max) }),
    },
  };
}
