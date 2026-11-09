import type { RefundRequest } from "@paypal/paypal-server-sdk";
import { encodeVerdictRef, requestIdFromDigest } from "./ids.ts";

/** `note_to_payer` maximum length. */
const NOTE_MAX = 255;

/**
 * The Refund Captured Payment call that returns a buyer's money under a verdict: the whole
 * capture (PayPal refuses partial refunds while a case is open), `custom_id` the verdict's
 * `ksv1.` reference and `PayPal-Request-Id` derived from its digest, so a retry is the same refund.
 */
export function verdictRefund(
  verdictId: string,
  digest: Uint8Array,
  note: string,
): { paypalRequestId: string; body: RefundRequest } {
  return {
    paypalRequestId: requestIdFromDigest(digest),
    body: { customId: encodeVerdictRef(verdictId, digest), noteToPayer: note.slice(0, NOTE_MAX) },
  };
}
