import { type Db, eq, mandates, purchaseHolds, transition } from "@keelson/db";
import { decodeMandate } from "@keelson/mandate";
import { type CheckedAuthorization, type ExpectedHold, holdCustomId } from "@keelson/paypal";
import type { RedisClientType } from "redis";
import { publishEvent } from "../events.ts";
import { MERCHANTS } from "../merchants.ts";
import type { PayPalDeps } from "../paypal.ts";
import { principalChannel } from "../principal.ts";

export type MandateRow = typeof mandates.$inferSelect;

interface Hold {
  mode: "mandate" | "per_purchase";
  orderId: string | null;
  /** The authorization captures use: the parent, or its reauthorization. */
  authorizationId: string | null;
  /** The original authorization; voids target it. */
  parentAuthorizationId: string | null;
  remainingMinor: bigint;
}

/**
 * The PayPal hold of a mandate, or `undefined` when there is no such mandate. Captures use
 * `authorizationId`; voids use `parentAuthorizationId`.
 *
 * @public
 */
export async function holdOf(db: Db, mandateId: string): Promise<Hold | undefined> {
  const [row] = await db
    .select({
      mode: mandates.holdMode,
      orderId: mandates.paypalOrderId,
      authorizationId: mandates.paypalAuthorizationId,
      parentAuthorizationId: mandates.paypalParentAuthorizationId,
      remainingMinor: mandates.remainingMinor,
    })
    .from(mandates)
    .where(eq(mandates.id, mandateId));
  return row;
}

interface PurchaseHold {
  mandateId: string;
  orderId: string;
  authorizationId: string | null;
  amountMinor: bigint;
  merchantId: string;
  state: "PENDING" | "AUTHORIZED" | "CAPTURED" | "VOIDED";
}

/**
 * The per-purchase hold countersigned under `requestId`, or `undefined` when there is none.
 * Captures of the purchase use its `authorizationId` with `final_capture: true`.
 *
 * @public
 */
export async function purchaseHoldOf(db: Db, requestId: string): Promise<PurchaseHold | undefined> {
  const [row] = await db
    .select({
      mandateId: purchaseHolds.mandateId,
      orderId: purchaseHolds.paypalOrderId,
      authorizationId: purchaseHolds.paypalAuthorizationId,
      amountMinor: purchaseHolds.amountMinor,
      merchantId: purchaseHolds.merchantId,
      state: purchaseHolds.state,
    })
    .from(purchaseHolds)
    .where(eq(purchaseHolds.requestId, requestId));
  return row;
}

/** The payee ids the signed mandate allows. */
export function allowedPayees(row: MandateRow): string[] {
  if (!row.payloadSd || !row.disclosures) return [];
  const m = decodeMandate(row.payloadSd as Record<string, unknown>, row.disclosures);
  const payees = m.payment.constraints.find((c) => c.type === "payment.allowed_payees");
  return payees?.type === "payment.allowed_payees"
    ? payees.allowed.map((p) => p.paypal_merchant_id)
    : [];
}

/**
 * Whether Keelson can capture a hold for the mandate: its one allowed merchant is the account
 * whose credentials capture, and the mandate allows paying that account.
 */
export function capturable(paypal: PayPalDeps, row: MandateRow): boolean {
  const [merchant, ...others] = row.merchantIds;
  const known = MERCHANTS.find((m) => m.id === merchant);
  return (
    others.length === 0 &&
    known?.paypal_merchant_id === paypal.merchantId &&
    allowedPayees(row).includes(paypal.merchantId)
  );
}

/**
 * Whether the mandate can hold its budget on Keelson's account: it allows paying that account.
 * When Keelson cannot also capture for its merchant, the hold only backs the countersign's budget
 * and the buyer pays each purchase at the store.
 */
export function holdable(paypal: PayPalDeps, row: MandateRow): boolean {
  return row.merchantIds.length === 1 && allowedPayees(row).includes(paypal.merchantId);
}

/** What PayPal's authorization of the mandate hold must say. */
export function expectedHold(paypal: PayPalDeps, row: MandateRow): ExpectedHold {
  if (!row.mandateHash) throw new Error(`mandate ${row.id} has no mandate hash`);
  return {
    customId: holdCustomId(paypal.env, row.id, row.mandateHash),
    amount: { currency: row.currency as ExpectedHold["amount"]["currency"], minor: row.maxMinor },
    payees: allowedPayees(row).filter((p) => p === paypal.merchantId),
  };
}

export interface HoldEventDeps {
  db: Db;
  kv: RedisClientType;
}

/** Publishes `mandate.hold` on the owner's `mandate:<id>` channel. */
export function publishHold(
  deps: HoldEventDeps,
  row: Pick<MandateRow, "id" | "userId">,
  event: { state: string; orderId?: string; authorizationId?: string },
): Promise<bigint> {
  return publishEvent(
    deps,
    principalChannel({ kind: "user", subject: row.userId }, `mandate:${row.id}`),
    row.id,
    { type: "mandate.hold", ...event },
  );
}

/** Moves a held mandate to `ACTIVE` on its checked authorization. Resolves to `false` if it left `HOLD_PENDING`. */
export async function activateHold(
  deps: HoldEventDeps,
  row: MandateRow,
  checked: CheckedAuthorization,
): Promise<boolean> {
  const moved = await transition(deps.db, "mandates", row.id, "HOLD_PENDING", "ACTIVE", {
    paypalAuthorizationId: checked.authorizationId,
    paypalParentAuthorizationId: checked.authorizationId,
    authorizedAt: checked.createTime,
  });
  if (moved) {
    await publishHold(deps, row, {
      state: "ACTIVE",
      ...(row.paypalOrderId ? { orderId: row.paypalOrderId } : {}),
      authorizationId: checked.authorizationId,
    });
  }
  return moved;
}
