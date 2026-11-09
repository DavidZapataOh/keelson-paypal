import type { Json } from "@keelson/core";
import {
  type Db,
  disputes,
  eq,
  inArray,
  mandates,
  type paypalEvents,
  purchaseHolds,
  purchases,
  sql,
  transition,
} from "@keelson/db";
import { type Dispute, getDispute, ids, PayPalError } from "@keelson/paypal";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import { reconcileHold } from "../hold/maintenance.ts";
import { call, type PayPalDeps, PayPalUnavailableError } from "../paypal.ts";
import { reconcileCapture } from "../pipeline/capture-step.ts";

export interface ApplyDeps {
  db: Db;
  kv: RedisClientType;
  log: Logger;
  paypal: PayPalDeps;
  /** Starts the evaluation of a dispute once it is stored; the dispute stays `OPEN` without it. */
  startDisputeWorkflow?: ((disputeId: string) => Promise<void>) | undefined;
}

export type EventRow = typeof paypalEvents.$inferSelect;

type Applied = "applied" | "ignored" | "mismatch" | "unresolvable";

export interface Application {
  status: Applied;
  /** The authenticated re-read the status was decided from. */
  resource?: unknown;
  purchaseId?: string | undefined;
  mandateId?: string | undefined;
  disputeId?: string | undefined;
}

/** PayPal answers these for a resource that is not there or not this app's to read. */
const MISSING = new Set([403, 404, 422]);

/**
 * Reads a resource from PayPal with the app's token. Throws on network failures, 5xx and other
 * answers worth retrying.
 */
async function readResource<T>(
  read: () => Promise<T>,
): Promise<{ status: "ok"; resource: T } | { status: "missing" }> {
  try {
    return { status: "ok", resource: await read() };
  } catch (err) {
    if (err instanceof PayPalError && MISSING.has(err.status)) return { status: "missing" };
    throw err;
  }
}

/** Wraps `getDispute`, whose errors come straight from the REST client, like the SDK calls. */
async function readDispute(paypal: PayPalDeps, id: string): Promise<Dispute> {
  try {
    return await getDispute(paypal.paypal.fetch, id);
  } catch (err) {
    if (err instanceof PayPalError && err.status < 500) throw err;
    throw new PayPalUnavailableError(err);
  }
}

const statusOf = (effect: "applied" | "unchanged" | "mismatch" | "ignored"): Applied =>
  effect === "unchanged" ? "applied" : effect;

/** The mandate whose hold is the order `orderId`: its own hold, or one of its cart holds. */
async function mandateOfOrder(db: Db, orderId: string): Promise<string | undefined> {
  const [own] = await db
    .select({ id: mandates.id })
    .from(mandates)
    .where(eq(mandates.paypalOrderId, orderId));
  if (own) return own.id;
  const [cart] = await db
    .select({ id: purchaseHolds.mandateId })
    .from(purchaseHolds)
    .where(eq(purchaseHolds.paypalOrderId, orderId));
  return cart?.id;
}

/**
 * Applies one stored event from an authenticated re-read of its resource. The event body only
 * names the resource; what changes is decided by what PayPal answers now, through the function
 * that owns the resource's state. Every effect is a conditional transition, so applying an event
 * twice, or out of order, changes nothing more.
 */
export async function applyEvent(deps: ApplyDeps, row: EventRow): Promise<Application> {
  const { payments } = deps.paypal.paypal;
  switch (row.eventType) {
    case "PAYMENT.AUTHORIZATION.CREATED":
    case "PAYMENT.AUTHORIZATION.VOIDED": {
      const read = await readResource(() =>
        call(payments.getAuthorizedPayment({ authorizationId: row.resourceId })),
      );
      if (read.status === "missing") return { status: "unresolvable" };
      const orderId = read.resource.supplementaryData?.relatedIds?.orderId;
      const mandateId = orderId ? await mandateOfOrder(deps.db, orderId) : undefined;
      if (!mandateId) return { status: "ignored", resource: read.resource };
      const { effect, resource } = await reconcileHold(deps, mandateId);
      return { status: statusOf(effect), resource: resource ?? read.resource, mandateId };
    }
    case "PAYMENT.CAPTURE.COMPLETED":
    case "PAYMENT.CAPTURE.DENIED":
      return capture(deps, row.resourceId);
    case "PAYMENT.CAPTURE.REFUNDED": {
      const read = await readResource(() => call(payments.getRefund({ refundId: row.resourceId })));
      if (read.status === "missing") return { status: "unresolvable" };
      const up = read.resource.links?.find((l) => l.rel === "up")?.href;
      const captureId =
        up && /\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(new URL(up).pathname)?.[1];
      if (!captureId) return { status: "ignored", resource: read.resource };
      const applied = await capture(deps, captureId);
      return { ...applied, resource: read.resource };
    }
    case "CUSTOMER.DISPUTE.CREATED":
    case "CUSTOMER.DISPUTE.UPDATED":
    case "CUSTOMER.DISPUTE.RESOLVED": {
      const read = await readResource(() => readDispute(deps.paypal, row.resourceId));
      if (read.status === "missing") return { status: "unresolvable" };
      return applyDispute(deps, read.resource, row.eventType);
    }
    default:
      return { status: "ignored" };
  }
}

async function capture(deps: ApplyDeps, captureId: string): Promise<Application> {
  const read = await readResource(() => reconcileCapture(deps, captureId));
  if (read.status === "missing") return { status: "unresolvable" };
  const { effect, purchaseId, resource } = read.resource;
  return { status: statusOf(effect), resource, purchaseId };
}

/** The purchase a dispute is about: by its capture's `invoice_id`, else by the capture id. */
async function purchaseOfDispute(db: Db, dispute: Dispute): Promise<string | undefined> {
  const transactions = dispute.disputed_transactions ?? [];
  const invoices = transactions
    .map((t) => t.invoice_number)
    .filter((n): n is string => n !== undefined && ids.parseInvoiceId(n) !== null);
  if (invoices.length > 0) {
    const [p] = await db
      .select({ id: purchases.id })
      .from(purchases)
      .where(inArray(purchases.invoiceId, invoices));
    if (p) return p.id;
  }
  const captures = transactions
    .map((t) => t.seller_transaction_id)
    .filter((id): id is string => id !== undefined);
  if (captures.length === 0) return undefined;
  const [p] = await db
    .select({ id: purchases.id })
    .from(purchases)
    .where(inArray(purchases.paypalCaptureId, captures));
  return p?.id;
}

/**
 * Stores a dispute as PayPal reports it and moves its purchase to `DISPUTED`; a resolved dispute
 * becomes `RESOLVED`. Then, unless the dispute is over, hands it to the dispute workflow.
 */
export async function applyDispute(
  deps: ApplyDeps,
  dispute: Dispute,
  eventType?: string,
): Promise<Application> {
  const purchaseId = await purchaseOfDispute(deps.db, dispute);
  if (!purchaseId) return { status: "ignored", resource: dispute };
  const id = dispute.dispute_id;
  const raw = dispute as unknown as Json;
  const resolved = dispute.status === "RESOLVED";
  await deps.db.transaction(async (tx) => {
    await tx
      .insert(disputes)
      .values({ id, purchaseId, reason: dispute.reason ?? "UNKNOWN", raw })
      .onConflictDoUpdate({
        target: disputes.id,
        set: { reason: dispute.reason ?? "UNKNOWN", raw, updatedAt: sql`now()` },
        setWhere: eq(disputes.purchaseId, purchaseId),
      });
    if (!(await transition(tx, "purchases", purchaseId, "CAPTURED", "DISPUTED"))) {
      await transition(tx, "purchases", purchaseId, "DELIVERED", "DISPUTED");
    }
    if (resolved && !(await transition(tx, "disputes", id, "OPEN", "RESOLVED"))) {
      await transition(tx, "disputes", id, "ATTRIBUTED", "RESOLVED");
    }
  });
  if (!resolved && eventType !== "CUSTOMER.DISPUTE.RESOLVED") {
    await deps.startDisputeWorkflow?.(id);
  }
  return { status: "applied", resource: dispute, purchaseId, disputeId: id };
}
