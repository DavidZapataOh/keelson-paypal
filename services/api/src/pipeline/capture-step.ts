import {
  alibiDigest,
  type CurrencyCode,
  fromPayPalValue,
  type Money,
  toHex,
  toPayPalValue,
} from "@keelson/core";
import {
  and,
  type Db,
  eq,
  inArray,
  isNull,
  like,
  mandates,
  or,
  purchaseCards,
  purchaseHolds,
  purchases,
  sql,
  transition,
} from "@keelson/db";
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
export const CAPTURE_WINDOW_SEC = ((v) => (Number.isSafeInteger(v) && v > 0 && v <= 600 ? v : 600))(
  Number(process.env.CAPTURE_WINDOW_SEC),
);
/** PayPal answers these for the caller or the moment, never for the capture itself. */
const TRANSIENT = new Set([401, 408, 409, 429]);
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
    const [{ mandateId } = { mandateId: undefined }] = await tx
      .select({ mandateId: purchases.mandateId })
      .from(purchases)
      .where(eq(purchases.id, purchaseId));
    if (!mandateId) return undefined;
    // The mandate first, then the purchase: every path that locks both locks them in this order.
    await tx.execute(sql`select 1 from mandates where id = ${mandateId} for update`);
    const [p] = await tx.select().from(purchases).where(eq(purchases.id, purchaseId)).for("update");
    if (!p?.countersign || !p.countersignDigest || !p.paypalOrderId) return undefined;
    const requestId = ids.requestIdFromDigest(p.countersignDigest);
    if (p.invoiceId) return { invoiceId: p.invoiceId, requestId, first: false };
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
      .where(and(eq(purchases.id, purchaseId), isNull(purchases.invoiceId)));
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
  const [p] = await db.select().from(purchases).where(eq(purchases.id, purchaseId));
  if (!p) throw new Error(`no purchase ${purchaseId}`);
  if (p.state === "CAPTURED" && p.paypalCaptureId) {
    return done({ captureId: p.paypalCaptureId, status: p.captureStatus ?? "COMPLETED" });
  }
  if (p.state !== "COVERED") return final(`capture:state-${p.state}`);
  const cs = p.countersign as unknown as CountersignJson;
  const amount = moneyOf(p);
  if (!p.paypalOrderId) return final("capture:no-order");
  // A process without PayPal leaves the capture to one that has it, while there is time.
  if (!paypal) {
    return now() / 1000 >= Number(cs.issuedAt) + CAPTURE_WINDOW_SEC
      ? final("capture:window-closed")
      : retry("capture:paypal-unavailable");
  }

  const invoice = await invoiceFor({ db, paypal }, purchaseId);
  if (!invoice) return final("capture:invoice-exhausted");
  const adopt = async (found: CaptureRecord | undefined) => {
    if (!found) return undefined;
    if (!sameMoney(found.amount, amount)) return final("capture:DUPLICATE_INVOICE_ID");
    await commitCapture(deps, purchaseId, found);
    return done({ captureId: found.id, status: found.status });
  };
  let sent = !invoice.first;
  /** Fails the purchase, unless a capture an earlier attempt sent is on the order after all. */
  const refuse = async (reason: string) =>
    (sent
      ? await adopt(await findCapture(paypal, p.paypalOrderId as string, invoice.invoiceId))
      : undefined) ?? final(reason);
  const closed = now() / 1000 >= Number(cs.issuedAt) + CAPTURE_WINDOW_SEC;

  try {
    if (closed) {
      sent = true;
      return await refuse("capture:window-closed");
    }
    if (sent) {
      const adopted = await adopt(await findCapture(paypal, p.paypalOrderId, invoice.invoiceId));
      if (adopted) return adopted;
    }

    const [m] = await db.select().from(mandates).where(eq(mandates.id, p.mandateId));
    if (m?.state !== "ACTIVE") return await refuse(`capture:mandate-${m?.state ?? "missing"}`);
    if (m.revokeRequestedAt !== null) return await refuse("capture:mandate-revoked");
    if (amount.minor > m.remainingMinor) return await refuse("capture:budget-exceeded");
    const perPurchase = m.holdMode === "per_purchase";
    const authorizationOf = async () => {
      if (!perPurchase) return (await holdOf(db, p.mandateId))?.authorizationId;
      const h = await purchaseHoldOf(db, purchaseId);
      return h?.mandateId === p.mandateId && h.state === "AUTHORIZED" ? h.authorizationId : null;
    };
    let authorizationId = await authorizationOf();
    if (!authorizationId) return await refuse("capture:no-authorization");
    const finalCapture = perPurchase || amount.minor === m.remainingMinor;

    for (let attempt = 0; ; attempt++) {
      try {
        sent = true;
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
        if (!sameMoney(capture.amount, amount)) {
          log.error({ purchaseId, captureId: res.id }, "PayPal captured another amount");
          return final("capture:amount-mismatch");
        }
        await commitCapture(deps, purchaseId, capture);
        return done({ captureId: capture.id, status: capture.status });
      } catch (err) {
        if (!(err instanceof PayPalError) || TRANSIENT.has(err.status)) throw err;
        const issue = err.details[0]?.issue ?? `HTTP_${err.status}`;
        if (AUTHORIZATION_GONE.has(issue) && attempt === 0) {
          const current = await authorizationOf();
          if (current && current !== authorizationId) {
            authorizationId = current;
            continue;
          }
        }
        return await refuse(`capture:${issue}`);
      }
    }
  } catch (err) {
    // A lookup or a call that PayPal did not answer for the capture itself: try again later.
    if (err instanceof PayPalError || err instanceof PayPalUnavailableError) {
      if (closed && err instanceof PayPalError && err.status === 404) {
        return final("capture:window-closed");
      }
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
    const recorded = {
      paypalCaptureId: capture.id,
      invoiceId: capture.invoiceId,
      captureStatus: capture.status,
      capturedAt: new Date(),
    };
    let moved = await transition(tx, "purchases", purchaseId, "COVERED", "CAPTURED", recorded);
    if (!moved) {
      // Failed at the capture step, yet PayPal captured: the capture is the truth.
      const repaired = await tx
        .update(purchases)
        .set({ ...recorded, state: "CAPTURED", failureReason: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(purchases.id, purchaseId),
            eq(purchases.state, "FAILED"),
            or(
              like(purchases.failureReason, "capture:%"),
              // A card voided and then force-posted, whose charge the hold now pays.
              inArray(purchases.failureReason, ["card:voided", "card:expired"]),
            ),
          ),
        )
        .returning({ id: purchases.id });
      moved = repaired.length > 0;
    }
    if (!moved) return undefined;
    const [p] = await tx
      .select({ mandateId: purchases.mandateId, amountMinor: purchases.amountMinor })
      .from(purchases)
      .where(eq(purchases.id, purchaseId));
    if (!p) throw new Error(`no purchase ${purchaseId}`);
    const [m] = await tx
      .update(mandates)
      // What was captured: the countersigned amount, or less when a card charge settled for less.
      .set({ remainingMinor: sql`${mandates.remainingMinor} - ${capture.amount.minor}` })
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
  // A card purchase's capture is the amount the network settled.
  const [card] =
    p.rail === "card"
      ? await db
          .select({ settled: purchaseCards.settledMinor })
          .from(purchaseCards)
          .where(eq(purchaseCards.purchaseId, p.id))
      : [];
  const expected =
    card?.settled != null
      ? { currency: p.currency as CurrencyCode, minor: card.settled }
      : moneyOf(p);
  if (!sameMoney(amount, expected)) {
    log.warn({ purchaseId, captureId }, "capture amount is not the countersigned amount");
    return { effect: "mismatch", purchaseId, resource };
  }
  const failedAtCapture = p.state === "FAILED" && p.failureReason?.startsWith("capture:");
  if (p.state === "COVERED" || failedAtCapture) {
    if (status === "DENIED" || status === "DECLINED" || status === "FAILED") {
      if (failedAtCapture) return { effect: "unchanged", purchaseId, resource };
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
    .where(
      and(
        eq(purchases.id, purchaseId),
        eq(purchases.paypalCaptureId, captureId),
        // Two reads in flight must not leave the older status last.
        p.captureStatus === null
          ? isNull(purchases.captureStatus)
          : eq(purchases.captureStatus, p.captureStatus),
      ),
    );
  if (status === "DENIED" || status === "DECLINED") {
    await publishPurchase(deps, purchaseId, { type: "purchase.capture_denied", captureId });
  }
  return { effect: "applied", purchaseId, resource };
}
