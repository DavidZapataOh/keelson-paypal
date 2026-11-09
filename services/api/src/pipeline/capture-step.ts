import {
  alibiDigest,
  type CurrencyCode,
  fromPayPalValue,
  type Money,
  toHex,
  toPayPalValue,
} from "@keelson/core";
import { and, type Db, eq, mandates, purchaseHolds, purchases, sql, transition } from "@keelson/db";
import { ids, PayPalError } from "@keelson/paypal";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import { voidHold } from "../hold/maintenance.ts";
import { holdOf, purchaseHoldOf } from "../hold/state.ts";
import { call, type PayPalDeps, PayPalUnavailableError } from "../paypal.ts";
import type { CountersignJson } from "../tee/client.ts";
import { publishPurchase } from "./events.ts";
import { done, final, type Outcome, retry } from "./outcome.ts";

/** A capture is sent only this long after the countersign was issued, well inside its lifetime. */
export const CAPTURE_WINDOW_SEC = Number(process.env.CAPTURE_WINDOW_SEC ?? 600);
/** Authorization refusals that mean the hold moved to another authorization or is gone. */
const AUTHORIZATION_GONE = new Set([
  "AUTHORIZATION_VOIDED",
  "AUTHORIZATION_EXPIRED",
  "RESOURCE_NOT_FOUND",
  "AUTHORIZATION_ALREADY_CAPTURED",
  "PREVIOUSLY_VOIDED",
]);
const UNUSABLE = new Set(["DECLINED", "FAILED"]);

export interface CaptureDeps {
  db: Db;
  kv: RedisClientType;
  log: Logger;
  paypal?: PayPalDeps | undefined;
}

/** @public */
export interface CaptureRecord {
  id: string;
  status: string;
  amount: Money;
  invoiceId: string;
  /** PayPal closed the authorization with it. */
  final: boolean;
}

type PurchaseRow = typeof purchases.$inferSelect;

const usd = (m: Money) => ({ currencyCode: m.currency, value: toPayPalValue(m) });
const moneyOf = (p: PurchaseRow): Money => ({
  currency: p.currency as CurrencyCode,
  minor: p.amountMinor,
});

/**
 * The capture's `invoice_id` and `PayPal-Request-Id`. The sequence number is taken once, under
 * the mandate's row lock, and the invoice id is stored with it, so every attempt sends the same.
 *
 * @internal
 */
export async function invoiceFor(
  deps: Pick<CaptureDeps, "db"> & { paypal: PayPalDeps },
  purchaseId: string,
): Promise<{ invoiceId: string; requestId: string; first: boolean } | undefined> {
  return deps.db.transaction(async (tx) => {
    const [p] = await tx.select().from(purchases).where(eq(purchases.id, purchaseId));
    if (!p?.countersign || !p.countersignDigest || !p.paypalOrderId) return undefined;
    const requestId = ids.requestIdFromDigest(p.countersignDigest);
    if (p.invoiceId) return { invoiceId: p.invoiceId, requestId, first: false };
    await tx.execute(sql`select 1 from mandates where id = ${p.mandateId} for update`);
    const [{ seq } = { seq: 1 }] = await tx
      .select({ seq: sql<number>`coalesce(max(${purchases.captureSeq}), 0)::int + 1` })
      .from(purchases)
      .where(eq(purchases.mandateId, p.mandateId));
    if (seq > 99) return undefined;
    const cs = p.countersign as unknown as CountersignJson;
    const digest = alibiDigest({
      mandateHash: cs.mandateHash,
      cartHash: cs.cartHash,
      policySetHash: cs.policySetHash,
      countersignDigest: toHex(p.countersignDigest),
      merchantId: deps.paypal.merchantId,
      amount: moneyOf(p),
      paypalOrderId: p.paypalOrderId,
    });
    const invoiceId = ids.encodeInvoiceId(purchaseId, seq, digest);
    await tx
      .update(purchases)
      .set({ captureSeq: seq, invoiceId })
      .where(eq(purchases.id, purchaseId));
    return { invoiceId, requestId, first: true };
  });
}

/**
 * The live capture of `orderId` that carries `invoiceId`, if PayPal has one.
 *
 * @internal
 */
export async function findCapture(
  paypal: PayPalDeps,
  orderId: string,
  invoiceId: string,
): Promise<CaptureRecord | undefined> {
  const order = await call(paypal.paypal.orders.getOrder({ id: orderId }));
  for (const unit of order.purchaseUnits ?? []) {
    const c = unit.payments?.captures?.find(
      (x) => x.invoiceId === invoiceId && !UNUSABLE.has(x.status ?? ""),
    );
    if (c?.id && c.amount?.currencyCode && c.amount.value) {
      return {
        id: c.id,
        status: c.status ?? "PENDING",
        amount: fromValue(c.amount.currencyCode, c.amount.value),
        invoiceId,
        final: c.finalCapture ?? false,
      };
    }
  }
  return undefined;
}

const fromValue = (currency: string, value: string): Money =>
  fromPayPalValue(currency as CurrencyCode, value);

const sameMoney = (a: Money, b: Money) => a.currency === b.currency && a.minor === b.minor;

/**
 * Captures exactly the countersigned amount from the hold, once. It runs only from `COVERED`, and
 * only inside the capture window; a purchase driven before is first looked up on its order, so a
 * capture PayPal made but the database never recorded is adopted rather than sent again.
 */
export async function captureStep(
  deps: CaptureDeps,
  purchaseId: string,
  now: () => number = Date.now,
): Promise<Outcome<{ captureId: string; status: string }>> {
  const { db, log, paypal } = deps;
  if (!paypal) return final("capture:paypal-unavailable");
  const [p] = await db.select().from(purchases).where(eq(purchases.id, purchaseId));
  if (!p) throw new Error(`no purchase ${purchaseId}`);
  if (p.state === "CAPTURED" && p.paypalCaptureId) {
    return done({ captureId: p.paypalCaptureId, status: p.captureStatus ?? "COMPLETED" });
  }
  if (p.state !== "COVERED") return final(`capture:state-${p.state}`);
  const cs = p.countersign as unknown as CountersignJson;
  const amount = moneyOf(p);
  if (!p.paypalOrderId) return final("capture:no-order");

  const invoice = await invoiceFor({ db, paypal }, purchaseId);
  if (!invoice) return final("capture:invoice-exhausted");
  const adopt = async (found: CaptureRecord | undefined) => {
    if (!found) return undefined;
    if (!sameMoney(found.amount, amount)) return final("capture:DUPLICATE_INVOICE_ID");
    await commitCapture(deps, purchaseId, found);
    return done({ captureId: found.id, status: found.status });
  };

  try {
    if (now() / 1000 >= Number(cs.issuedAt) + CAPTURE_WINDOW_SEC) {
      return (
        (await adopt(await findCapture(paypal, p.paypalOrderId, invoice.invoiceId))) ??
        final("capture:window-closed")
      );
    }
    if (!invoice.first) {
      const adopted = await adopt(await findCapture(paypal, p.paypalOrderId, invoice.invoiceId));
      if (adopted) return adopted;
    }

    const [m] = await db.select().from(mandates).where(eq(mandates.id, p.mandateId));
    if (m?.state !== "ACTIVE") return final(`capture:mandate-${m?.state ?? "missing"}`);
    const perPurchase = m.holdMode === "per_purchase";
    const authorizationOf = async () =>
      perPurchase
        ? (await purchaseHoldOf(db, purchaseId))?.authorizationId
        : (await holdOf(db, p.mandateId))?.authorizationId;
    let authorizationId = await authorizationOf();
    if (!authorizationId) return final("capture:no-authorization");
    const finalCapture = perPurchase || amount.minor === m.remainingMinor;

    for (let attempt = 0; ; attempt++) {
      try {
        const res = await call(
          paypal.paypal.payments.captureAuthorizedPayment({
            authorizationId,
            paypalRequestId: invoice.requestId,
            prefer: "return=representation",
            body: { amount: usd(amount), invoiceId: invoice.invoiceId, finalCapture },
          }),
        );
        if (!res.id || !res.amount?.currencyCode || !res.amount.value) {
          return retry("capture:malformed-response");
        }
        log.info({ purchaseId, captureId: res.id, status: res.status }, "capture.sent");
        const capture: CaptureRecord = {
          id: res.id,
          status: res.status ?? "PENDING",
          amount: fromValue(res.amount.currencyCode, res.amount.value),
          invoiceId: invoice.invoiceId,
          final: finalCapture,
        };
        if (!sameMoney(capture.amount, amount)) return final("capture:amount-mismatch");
        await commitCapture(deps, purchaseId, capture);
        return done({ captureId: capture.id, status: capture.status });
      } catch (err) {
        if (!(err instanceof PayPalError)) throw err;
        const issue = err.details[0]?.issue ?? `HTTP_${err.status}`;
        if (issue === "DUPLICATE_INVOICE_ID") {
          return (
            (await adopt(await findCapture(paypal, p.paypalOrderId, invoice.invoiceId))) ??
            final("capture:DUPLICATE_INVOICE_ID")
          );
        }
        if (AUTHORIZATION_GONE.has(issue) && attempt === 0) {
          const current = await authorizationOf();
          if (current && current !== authorizationId) {
            authorizationId = current;
            continue;
          }
        }
        return final(`capture:${issue}`);
      }
    }
  } catch (err) {
    if (err instanceof PayPalError) return final(`capture:HTTP_${err.status}`);
    if (err instanceof PayPalUnavailableError) {
      return retry("capture:paypal-unavailable");
    }
    throw err;
  }
}

/**
 * Records a capture PayPal made: `COVERED → CAPTURED` and the mandate's budget reduced by its
 * amount in one transaction. Whoever sees the capture first, the pipeline or a reconciliation,
 * records it; the other finds it recorded.
 *
 * @public
 */
export async function commitCapture(
  deps: CaptureDeps,
  purchaseId: string,
  capture: CaptureRecord,
): Promise<"applied" | "unchanged"> {
  const { db } = deps;
  const applied = await db.transaction(async (tx) => {
    const moved = await transition(tx, "purchases", purchaseId, "COVERED", "CAPTURED", {
      paypalCaptureId: capture.id,
      invoiceId: capture.invoiceId,
      captureStatus: capture.status,
      capturedAt: new Date(),
    });
    if (!moved) return undefined;
    const [p] = await tx
      .select({ mandateId: purchases.mandateId, amountMinor: purchases.amountMinor })
      .from(purchases)
      .where(eq(purchases.id, purchaseId));
    if (!p) throw new Error(`no purchase ${purchaseId}`);
    const [m] = await tx
      .update(mandates)
      .set({ remainingMinor: sql`${mandates.remainingMinor} - ${p.amountMinor}` })
      .where(eq(mandates.id, p.mandateId))
      .returning({
        id: mandates.id,
        userId: mandates.userId,
        holdMode: mandates.holdMode,
        remainingMinor: mandates.remainingMinor,
      });
    if (!m) throw new Error(`no mandate for purchase ${purchaseId}`);
    if (m.holdMode === "per_purchase") {
      await tx
        .update(purchaseHolds)
        .set({ state: "CAPTURED", updatedAt: new Date() })
        .where(eq(purchaseHolds.requestId, purchaseId));
    }
    return m;
  });
  if (!applied) {
    const [p] = await db
      .select({ state: purchases.state, captureId: purchases.paypalCaptureId })
      .from(purchases)
      .where(eq(purchases.id, purchaseId));
    if (p?.state === "CAPTURED" && p.captureId === capture.id) return "unchanged";
    throw new Error(`purchase ${purchaseId} cannot record capture ${capture.id}`);
  }
  if (applied.holdMode === "mandate") {
    if (capture.final) {
      await transition(db, "mandates", applied.id, "ACTIVE", "EXHAUSTED");
    } else if (applied.remainingMinor === 0n && deps.paypal) {
      await voidHold({ ...deps, paypal: deps.paypal }, applied.id, "EXHAUSTED").catch(
        (err: unknown) =>
          deps.log.warn({ err, mandateId: applied.id }, "exhausted hold not voided yet"),
      );
    }
  }
  await publishPurchase(deps, purchaseId, {
    type: "purchase.captured",
    captureId: capture.id,
    invoiceId: capture.invoiceId,
    amount: { currency: capture.amount.currency, minor: capture.amount.minor.toString() },
  });
  return "applied";
}

/**
 * Applies what PayPal says about a capture, read again from PayPal: the purchase is the one its
 * `invoice_id` names, never what a notification claims.
 *
 * @public
 */
export async function reconcileCapture(
  deps: CaptureDeps,
  captureId: string,
): Promise<{
  effect: "applied" | "unchanged" | "mismatch" | "ignored";
  purchaseId?: string;
  resource: unknown;
}> {
  const { db, log, paypal } = deps;
  if (!paypal) throw new Error("PayPal is not configured");
  const resource = await call(paypal.paypal.payments.getCapturedPayment({ captureId }));
  const parsed = resource.invoiceId ? ids.parseInvoiceId(resource.invoiceId) : null;
  if (!parsed) return { effect: "ignored", resource };
  const [p] = await db.select().from(purchases).where(eq(purchases.id, parsed.id));
  if (!p || p.invoiceId !== resource.invoiceId) return { effect: "ignored", resource };
  const purchaseId = p.id;
  const status: string = resource.status ?? "PENDING";
  if (!resource.amount?.currencyCode || !resource.amount.value) {
    return { effect: "mismatch", purchaseId, resource };
  }
  const amount = fromValue(resource.amount.currencyCode, resource.amount.value);
  if (!sameMoney(amount, moneyOf(p))) {
    log.warn({ purchaseId, captureId }, "capture amount is not the countersigned amount");
    return { effect: "mismatch", purchaseId, resource };
  }
  if (p.state === "COVERED") {
    if (status === "DENIED" || status === "DECLINED" || status === "FAILED") {
      const moved = await transition(db, "purchases", purchaseId, "COVERED", "FAILED", {
        failureReason: `capture:${status}`,
      });
      if (moved)
        await publishPurchase(deps, purchaseId, {
          type: "purchase.failed",
          step: "capture",
          reason: status,
        });
      return { effect: moved ? "applied" : "unchanged", purchaseId, resource };
    }
    const effect = await commitCapture(deps, purchaseId, {
      id: captureId,
      status,
      amount,
      invoiceId: resource.invoiceId as string,
      final: resource.finalCapture ?? false,
    });
    return { effect, purchaseId, resource };
  }
  if (p.paypalCaptureId !== captureId) return { effect: "mismatch", purchaseId, resource };
  if (p.captureStatus === status) return { effect: "unchanged", purchaseId, resource };
  await db
    .update(purchases)
    .set({ captureStatus: status })
    .where(and(eq(purchases.id, purchaseId), eq(purchases.paypalCaptureId, captureId)));
  if (status === "DENIED" || status === "DECLINED") {
    await publishPurchase(deps, purchaseId, { type: "purchase.capture_denied", captureId });
  }
  return { effect: "applied", purchaseId, resource };
}
