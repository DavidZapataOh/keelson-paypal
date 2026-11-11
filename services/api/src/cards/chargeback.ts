import { type CurrencyCode, sha256, toPayPalValue } from "@keelson/core";
import { type cardChargebacks, type Db, eq, purchases } from "@keelson/db";
import { ids } from "@keelson/paypal";
import type { Logger } from "pino";
import { call, type PayPalDeps } from "../paypal.ts";

/**
 * The chargebacks a card purchase's user may file, the issuer's reason for each and the reason
 * codes the card networks file it under: Visa 10.4 (card-absent fraud), 13.1 (not received) and
 * 13.3 (not as described); Mastercard 4837 (no cardholder authorization) and 4853 (cardholder
 * dispute).
 */
export const CHARGEBACK_REASONS = {
  not_received: { issuer: "GOODS_SERVICES_NOT_RECEIVED", visa: "13.1", mastercard: "4853" },
  not_as_described: {
    issuer: "GOODS_SERVICES_NOT_AS_DESCRIBED",
    visa: "13.3",
    mastercard: "4853",
  },
  unauthorized: { issuer: "FRAUD_CARD_NOT_PRESENT", visa: "10.4", mastercard: "4837" },
} as const;

export type ChargebackReason = keyof typeof CHARGEBACK_REASONS;

/** Issuer statuses after which a chargeback's outcome is known. */
const DECIDED = new Set(["CASE_WON", "CASE_CLOSED"]);
/** Resolutions that returned the disputed amount to the cardholder. */
const RETURNED = new Set([
  "WON_FIRST_CHARGEBACK",
  "WON_PREARBITRATION",
  "WON_ARBITRATION",
  "REFUNDED",
  "REFUNDED_AFTER_CHARGEBACK",
]);

/** Whether a chargeback in `status` is still being decided. */
export const chargebackOpen = (status: string): boolean => !DECIDED.has(status);

/**
 * What a decided chargeback returned to the cardholder: its amount when the issuer won it or the
 * merchant refunded, nothing otherwise; `null` while it is open.
 */
export function chargebackRecovered(
  status: string,
  resolution: string | null,
  amountMinor: bigint,
): bigint | null {
  if (chargebackOpen(status)) return null;
  return status === "CASE_WON" || (resolution !== null && RETURNED.has(resolution))
    ? amountMinor
    : 0n;
}

/**
 * The most a bond claim over a card purchase may pay: what the user lost less what the card
 * network already returned, so the user is never paid twice. Nothing is claimed while a
 * chargeback is still being decided.
 */
export function bondClaimMinor(
  lossMinor: bigint,
  chargebacks: readonly { status: string; recoveredMinor: bigint | null }[],
): bigint {
  if (chargebacks.some((c) => chargebackOpen(c.status))) return 0n;
  const recovered = chargebacks.reduce((n, c) => n + (c.recoveredMinor ?? 0n), 0n);
  return lossMinor > recovered ? lossMinor - recovered : 0n;
}

/** A chargeback as the API shows it, with the network reason codes it was filed under. */
export function chargebackView(c: typeof cardChargebacks.$inferSelect) {
  const codes = CHARGEBACK_REASONS[c.reason as ChargebackReason];
  return {
    id: c.id,
    purchaseId: c.purchaseId,
    reason: c.reason,
    networkCodes: { visa: codes.visa, mastercard: codes.mastercard },
    amountMinor: c.amountMinor.toString(),
    status: c.status,
    resolution: c.resolution,
    recoveredMinor: c.recoveredMinor?.toString() ?? null,
    evidenceUploaded: c.evidenceUploaded,
  };
}

/**
 * Returns to the user's PayPal account what the card network returned to Keelson for a card
 * purchase: a chargeback the issuer won, or a merchant's refund to the card. Keyed by the issuer's
 * id of that return, so it is refunded once however often it is reported.
 */
export async function refundToUser(
  deps: { db: Db; log: Logger; paypal?: PayPalDeps | undefined },
  purchaseId: string,
  returnId: string,
  amountMinor: bigint,
  note: string,
): Promise<void> {
  if (amountMinor <= 0n) return;
  const [p] = await deps.db
    .select({ captureId: purchases.paypalCaptureId, currency: purchases.currency })
    .from(purchases)
    .where(eq(purchases.id, purchaseId));
  if (!p?.captureId) {
    deps.log.error({ purchaseId, returnId }, "a card return to pass on, but nothing was collected");
    return;
  }
  if (!deps.paypal) throw new Error("PayPal is not configured to refund the user");
  const money = { currency: p.currency as CurrencyCode, minor: amountMinor };
  const refund = await call(
    deps.paypal.paypal.payments.refundCapturedPayment({
      captureId: p.captureId,
      paypalRequestId: ids.requestIdFromDigest(
        sha256(new TextEncoder().encode(`card-return:${returnId}`)),
      ),
      body: {
        amount: { currencyCode: money.currency, value: toPayPalValue(money) },
        noteToPayer: note,
      },
    }),
  );
  deps.log.info({ purchaseId, returnId, refundId: refund.id }, "card return refunded to the user");
}
