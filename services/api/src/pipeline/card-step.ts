import { type CurrencyCode, fromPayPalValue, type Money, toPayPalValue } from "@keelson/core";
import {
  and,
  type Db,
  eq,
  inArray,
  isNotNull,
  lt,
  mandates,
  or,
  purchaseCards,
  purchases,
  sql,
} from "@keelson/db";
import { decodeMandate, type Mandate } from "@keelson/mandate";
import { PayPalError } from "@keelson/paypal";
import type { Logger } from "pino";
import type { CardIssuer } from "../cards/issuer.ts";
import { holdOf } from "../hold/state.ts";
import { call, PayPalUnavailableError } from "../paypal.ts";
import type { CountersignJson } from "../tee/client.ts";
import { type CaptureDeps, commitCapture, findCapture, invoiceFor } from "./capture-step.ts";
import { done, final, type Outcome, retry } from "./outcome.ts";

export interface CardStepDeps {
  db: Db;
  log: Logger;
  cardIssuer?: CardIssuer | undefined;
}

/** The merchant category codes and countries a card mandate allows for the cart's merchant. */
function cardControlsOf(
  m: Mandate,
  merchantId: string,
): { mcc: string[]; countries: string[] } | undefined {
  const allowed = m.checkout.constraints.find((c) => c.type === "checkout.allowed_merchants");
  if (allowed?.type !== "checkout.allowed_merchants") return undefined;
  // The countersign names the merchant as the mandate does: `*` for any store.
  const x = allowed.allowed.find((x) => x.id === merchantId);
  if (!x?.mcc || !x.country) return undefined;
  return { mcc: [...x.mcc], countries: [x.country] };
}

/**
 * Issues the single-use card of a card purchase, paused, once its 2-of-2 ALLOW is stored: capped
 * at the countersigned amount, at the merchant category codes and country the mandate allows for
 * the cart's merchant, and usable until the countersign expires. The card is issued before the
 * purchase is logged, so its leaf commits to the card. A card issued twice by concurrent drivers
 * is closed again.
 */
export async function issueCardStep(
  deps: CardStepDeps,
  purchaseId: string,
): Promise<Outcome<{ token: string }>> {
  const { db } = deps;
  const [existing] = await db
    .select({ token: purchaseCards.cardToken })
    .from(purchaseCards)
    .where(eq(purchaseCards.purchaseId, purchaseId));
  if (existing) return done(existing);
  if (!deps.cardIssuer) return final("card:not-configured");
  const [row] = await db
    .select({ purchase: purchases, mandate: mandates })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .where(eq(purchases.id, purchaseId));
  if (!row) return final("card:no-purchase");
  const { purchase, mandate } = row;
  // A card answers to both legs at every authorization: one leg alone issues none.
  if (purchase.countersignMode !== "2of2") return final("card:not-2of2");
  const cs = purchase.countersign as unknown as CountersignJson | null;
  const expiresAt = new Date(Number(cs?.expiresAt) * 1000);
  if (!cs || !(expiresAt.getTime() > Date.now())) return final("card:expired");
  if (!mandate.payloadSd || !mandate.disclosures) return final("card:mandate-unreadable");
  const controls = cardControlsOf(
    decodeMandate(mandate.payloadSd as Record<string, unknown>, mandate.disclosures),
    purchase.merchantId,
  );
  if (!controls) return final("card:merchant-not-allowed");
  let issued: Awaited<ReturnType<CardIssuer["issue"]>>;
  try {
    issued = await deps.cardIssuer.issue({
      spendLimitMinor: purchase.amountMinor,
      mcc: controls.mcc,
      countries: controls.countries,
      memo: `Keelson ${purchaseId}`,
    });
  } catch (err) {
    deps.log.warn({ err, purchaseId }, "card not issued");
    return retry("card:issuer-unavailable");
  }
  const stored = await db
    .insert(purchaseCards)
    .values({
      purchaseId,
      issuer: deps.cardIssuer.name,
      cardToken: issued.token,
      lastFour: issued.lastFour,
      controls: {
        spend_limit_minor: purchase.amountMinor.toString(),
        currency: purchase.currency,
        mcc: controls.mcc,
        countries: controls.countries,
        single_use: true,
      },
      state: "PAUSED",
      expiresAt,
    })
    .onConflictDoNothing({ target: purchaseCards.purchaseId })
    .returning({ token: purchaseCards.cardToken });
  if (stored[0]) return done(stored[0]);
  await deps.cardIssuer.close(issued.token).catch((err: unknown) => {
    deps.log.error({ err, purchaseId }, "duplicate card not closed");
  });
  const [winner] = await db
    .select({ token: purchaseCards.cardToken })
    .from(purchaseCards)
    .where(eq(purchaseCards.purchaseId, purchaseId));
  return winner ? done(winner) : retry("card:conflict");
}

/** Opens the purchase's card once the purchase is logged and covered, as a capture would run. */
export async function openCardStep(
  deps: CardStepDeps,
  purchaseId: string,
): Promise<Outcome<{ token: string }>> {
  const { db } = deps;
  const [card] = await db
    .select()
    .from(purchaseCards)
    .where(eq(purchaseCards.purchaseId, purchaseId));
  if (!card) return final("card:not-issued");
  if (card.state !== "PAUSED") return done({ token: card.cardToken });
  if (!deps.cardIssuer) return final("card:not-configured");
  if (card.expiresAt.getTime() <= Date.now()) return final("card:expired");
  try {
    await deps.cardIssuer.open(card.cardToken);
  } catch (err) {
    deps.log.warn({ err, purchaseId }, "card not opened");
    return retry("card:issuer-unavailable");
  }
  await db
    .update(purchaseCards)
    .set({ state: "OPEN" })
    .where(and(eq(purchaseCards.purchaseId, purchaseId), eq(purchaseCards.state, "PAUSED")));
  return done({ token: card.cardToken });
}

/**
 * Closes the cards never used before their countersign expired or their mandate ended, and fails
 * their purchases, so nothing can be authorized on them later. Returns how many it closed.
 */
export async function closeExpiredCards(deps: CardStepDeps): Promise<number> {
  const { db } = deps;
  const expired = await db
    .select({ purchaseId: purchaseCards.purchaseId, token: purchaseCards.cardToken })
    .from(purchaseCards)
    .innerJoin(purchases, eq(purchases.id, purchaseCards.purchaseId))
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .where(
      and(
        inArray(purchaseCards.state, ["PAUSED", "OPEN"]),
        // Unused past its countersign, or its mandate ended: a revoked mandate leaves no open card.
        or(
          lt(purchaseCards.expiresAt, sql`now()`),
          inArray(mandates.state, ["REVOKED", "EXPIRED", "EXHAUSTED"]),
        ),
      ),
    )
    .limit(20);
  let closed = 0;
  for (const card of expired) {
    if (!deps.cardIssuer) break;
    try {
      await deps.cardIssuer.close(card.token);
    } catch (err) {
      deps.log.warn({ err, purchaseId: card.purchaseId }, "expired card not closed");
      continue;
    }
    await db.transaction(async (tx) => {
      await tx
        .update(purchaseCards)
        .set({ state: "CLOSED" })
        .where(
          and(
            eq(purchaseCards.purchaseId, card.purchaseId),
            inArray(purchaseCards.state, ["PAUSED", "OPEN"]),
          ),
        );
      await tx
        .update(purchases)
        .set({ state: "FAILED", failureReason: "card:expired", updatedAt: sql`now()` })
        .where(
          and(
            eq(purchases.id, card.purchaseId),
            inArray(purchases.state, ["COUNTERSIGNED", "LOGGED", "COVERED"]),
          ),
        );
    });
    closed++;
  }
  return closed;
}

/**
 * Collects a settled card charge from the user's PayPal hold: captures exactly what the card
 * network settled, once, under the purchase's invoice id. A capture an earlier attempt made is
 * found on the order and recorded instead of being sent again. Unlike a PayPal purchase there is
 * no capture window: the network already paid the merchant, and the hold stays authorized until
 * the mandate ends.
 */
export async function captureCardStep(
  deps: CaptureDeps,
  purchaseId: string,
): Promise<Outcome<{ captureId: string; status: string }>> {
  const { db, log, paypal } = deps;
  const [row] = await db
    .select({ purchase: purchases, card: purchaseCards })
    .from(purchases)
    .innerJoin(purchaseCards, eq(purchaseCards.purchaseId, purchases.id))
    .where(eq(purchases.id, purchaseId));
  if (!row) return final("capture:no-card");
  const { purchase: p, card } = row;
  if (p.state === "CAPTURED" && p.paypalCaptureId) {
    return done({ captureId: p.paypalCaptureId, status: p.captureStatus ?? "COMPLETED" });
  }
  // A card voided and then force-posted failed its purchase; the network paid all the same.
  const forcePosted =
    p.state === "FAILED" &&
    (p.failureReason === "card:voided" || p.failureReason === "card:expired");
  if (p.state !== "COVERED" && !forcePosted) return final(`capture:state-${p.state}`);
  if (card.settledMinor === null) return retry("capture:not-settled");
  if (!p.paypalOrderId) return final("capture:no-order");
  if (!paypal) return retry("capture:paypal-unavailable");
  const amount: Money = { currency: p.currency as CurrencyCode, minor: card.settledMinor };
  const invoice = await invoiceFor({ db, paypal }, purchaseId);
  if (!invoice) return uncollected("invoice-exhausted");
  /**
   * A settled charge is never written off: the purchase stays covered, counted against the
   * budget, and the collection is tried again on the next drive while someone looks.
   */
  function uncollected(reason: string) {
    log.error({ purchaseId, reason }, "settled card charge not collected from the hold");
    return retry(`capture:${reason}`);
  }
  try {
    const found = await findCapture(paypal, p.paypalOrderId, invoice.invoiceId);
    if (found) {
      if (found.amount.minor !== amount.minor) return uncollected("DUPLICATE_INVOICE_ID");
      await commitCapture(deps, purchaseId, found);
      return done({ captureId: found.id, status: found.status });
    }
    // The network already paid the merchant: the charge is collected even from a mandate revoked
    // or expired since, whose hold waits for it.
    const [m] = await db.select().from(mandates).where(eq(mandates.id, p.mandateId));
    if (!m) return final("capture:mandate-missing");
    if (amount.minor > m.remainingMinor) return uncollected("budget-exceeded");
    const authorizationId = (await holdOf(db, p.mandateId))?.authorizationId;
    if (!authorizationId) return uncollected("no-authorization");
    const finalCapture = amount.minor === m.remainingMinor;
    const res = await call(
      paypal.paypal.payments.captureAuthorizedPayment({
        authorizationId,
        paypalRequestId: invoice.requestId,
        prefer: "return=representation",
        body: {
          amount: { currencyCode: amount.currency, value: toPayPalValue(amount) },
          invoiceId: invoice.invoiceId,
          finalCapture,
        },
      }),
    );
    if (!res.id || !res.amount?.currencyCode || !res.amount.value) {
      return retry("capture:malformed-response");
    }
    const captured = fromPayPalValue(res.amount.currencyCode as CurrencyCode, res.amount.value);
    if (captured.minor !== amount.minor) return uncollected("amount-mismatch");
    log.info({ purchaseId, captureId: res.id, status: res.status }, "card capture.sent");
    await commitCapture(deps, purchaseId, {
      id: res.id,
      status: res.status ?? "PENDING",
      amount: captured,
      invoiceId: invoice.invoiceId,
      final: finalCapture,
    });
    return done({ captureId: res.id, status: res.status ?? "PENDING" });
  } catch (err) {
    if (err instanceof PayPalError && !TRANSIENT.has(err.status)) {
      return uncollected(err.details[0]?.issue ?? `HTTP_${err.status}`);
    }
    if (err instanceof PayPalError || err instanceof PayPalUnavailableError) {
      return retry("capture:paypal-unavailable");
    }
    throw err;
  }
}

/** PayPal answers these for the caller or the moment, never for the capture itself. */
const TRANSIENT = new Set([401, 408, 409, 429]);

/**
 * Collects the charges of cards voided and then force-posted by the merchant: their purchase
 * failed, but the network paid. Returns how many it tried.
 */
export async function collectForcePosted(deps: CaptureDeps): Promise<number> {
  const rows = await deps.db
    .select({ id: purchases.id })
    .from(purchases)
    .innerJoin(purchaseCards, eq(purchaseCards.purchaseId, purchases.id))
    .where(
      and(
        eq(purchases.state, "FAILED"),
        inArray(purchases.failureReason, ["card:voided", "card:expired"]),
        isNotNull(purchaseCards.settledMinor),
      ),
    )
    .limit(20);
  for (const r of rows) await captureCardStep(deps, r.id);
  return rows.length;
}
