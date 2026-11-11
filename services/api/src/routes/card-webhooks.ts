import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, cardAuthorizations, eq, inArray, purchaseCards, purchases, sql } from "@keelson/db";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Deps } from "../app.ts";
import { type CardResult, decide } from "../cards/authorize.ts";
import { alpha2, type CardIssuer } from "../cards/issuer.ts";
import { captureCardStep } from "../pipeline/card-step.ts";
import { publishPurchase } from "../pipeline/events.ts";
import { problem } from "../problem.ts";
import { span } from "../tracing.ts";
import { applyChargeback } from "./chargebacks.ts";

/** The latest the API answers an authorization: past it, the issuer is told to decline. */
const ANSWER_DEADLINE_MS = 2_500;

const AsaRequest = z.looseObject({
  /** The transaction the request belongs to; several requests may share it. */
  token: z.string().min(1).max(256),
  /** This request's own id, which the issuer repeats when it retries it. */
  event_token: z.string().min(1).max(256).optional(),
  status: z.string(),
  amounts: z.looseObject({
    cardholder: z.looseObject({ amount: z.number().int(), currency: z.string() }),
  }),
  card: z.looseObject({ token: z.string().min(1).max(256) }),
  merchant: z.looseObject({
    acceptor_id: z.string().max(256),
    descriptor: z.string().max(256),
    mcc: z.string().max(8),
    country: z.string().max(8),
  }),
});

const DisputeEvent = z.looseObject({
  event_type: z.literal("dispute.updated"),
  token: z.string(),
  status: z.string(),
  resolution_reason: z.string().nullable().optional(),
});

const TransactionEvent = z.looseObject({
  event_type: z.string(),
  token: z.string().optional(),
  card_token: z.string().optional(),
  status: z.string().optional(),
  settled_amount: z.number().int().optional(),
});

/** The authorizations a card may be approved for: purchases, not balance checks. */
const PURCHASES = new Set(["AUTHORIZATION", "FINANCIAL_AUTHORIZATION"]);
/** A merchant's refund to the card: money in, approved without a check. */
const CREDITS = new Set(["CREDIT_AUTHORIZATION", "FINANCIAL_CREDIT_AUTHORIZATION"]);

/**
 * The card issuer's real-time authorization requests (Lithic Auth Stream Access) and its card
 * transaction events. Both are verified against the issuer's signature over the exact bytes
 * before they are parsed. They sit outside `/v1`: the issuer authenticates with its signature.
 */
export function registerCardWebhooks(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "log" | "tee" | "cards" | "paypal" | "startDisputeWorkflow">,
): void {
  const limit = bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => problem(c, 413, "payload-too-large", "Payload too large"),
  });

  /** The issuer's verified body, or `undefined` when it is not signed with `secret`. */
  async function verified(c: Context, issuer: CardIssuer, secret: string) {
    const body = await c.req.text();
    try {
      return issuer.verify(body, c.req.raw.headers, secret);
    } catch {
      return undefined;
    }
  }

  // Answers within the issuer's window, and declines whatever cannot be decided: Lithic declines
  // on a 4xx answer or none.
  app.post("/webhooks/lithic/asa", limit, (c) =>
    span("card.authorize", {}, async (s) => {
      const receivedAt = performance.now();
      const issuer = deps.cards?.issuer;
      const secret = deps.cards?.asaSecret;
      if (!issuer || !secret) return problem(c, 503, "cards-unconfigured", "Cards unconfigured");
      const raw = await verified(c, issuer, secret);
      if (raw === undefined) {
        deps.log.warn("card authorization refused: bad signature");
        return problem(c, 400, "invalid-signature", "Invalid signature");
      }
      const parsed = AsaRequest.safeParse(raw);
      const decline = (result: CardResult) => c.json({ result }, 200);
      if (parsed.success && CREDITS.has(parsed.data.status)) {
        return c.json({ result: "APPROVED" }, 200);
      }
      if (!parsed.success || !PURCHASES.has(parsed.data.status)) return decline("SUSPECTED_FRAUD");
      const r = parsed.data;
      s.setAttribute("card.authorization", r.token);
      const timeout = new Promise<{ result: CardResult }>((resolve) =>
        setTimeout(() => resolve({ result: "SUSPECTED_FRAUD" }), ANSWER_DEADLINE_MS).unref(),
      );
      const out = await Promise.race([
        decide(
          deps,
          {
            id: r.event_token ?? r.token,
            transactionToken: r.token,
            cardToken: r.card.token,
            amount_minor: r.amounts.cardholder.amount,
            currency: r.amounts.cardholder.currency,
            mcc: r.merchant.mcc,
            merchant_name: r.merchant.descriptor,
            // A country the mandate cannot name declines on its country.
            merchant_country: alpha2(r.merchant.country) ?? "ZZ",
            network_id: r.merchant.acceptor_id,
          },
          receivedAt,
        ).catch((err: unknown) => {
          deps.log.error({ err, authorization: r.token }, "card authorization not decided");
          return { result: "SUSPECTED_FRAUD" as const };
        }),
        timeout,
      ]);
      s.setAttribute("card.result", out.result);
      deps.log.info(
        {
          authorization: r.token,
          result: out.result,
          ms: Math.round(performance.now() - receivedAt),
        },
        "card authorization answered",
      );
      return c.json({ result: out.result }, 200);
    }),
  );

  // Verified before anything else, and not rate limited: a limit counting the proxy's address
  // would let unsigned requests crowd out the issuer's.
  app.post("/webhooks/lithic", limit, async (c) => {
    const issuer = deps.cards?.issuer;
    const secret = deps.cards?.webhookSecret;
    if (!issuer || !secret) return problem(c, 503, "cards-unconfigured", "Cards unconfigured");
    const raw = await verified(c, issuer, secret);
    if (raw === undefined) return problem(c, 400, "invalid-signature", "Invalid signature");
    const d = DisputeEvent.safeParse(raw);
    if (d.success) {
      await applyChargeback(deps, {
        token: d.data.token,
        status: d.data.status,
        resolution: d.data.resolution_reason ?? null,
      });
      return c.body(null, 200);
    }
    const e = TransactionEvent.safeParse(raw);
    if (!e.success || e.data.event_type !== "card_transaction.updated" || !e.data.card_token) {
      return c.body(null, 200);
    }
    await applyTransaction(deps, {
      cardToken: e.data.card_token,
      transactionToken: e.data.token ?? "",
      status: e.data.status ?? "",
      settledMinor: e.data.settled_amount ?? 0,
    });
    return c.body(null, 200);
  });
}

/**
 * Records what the card network did with a purchase card's approved authorization: a settled
 * transaction captures the purchase, a voided or expired one closes the card and fails it.
 */
export async function applyTransaction(
  deps: Pick<Deps, "db" | "kv" | "log" | "cards" | "paypal">,
  t: { cardToken: string; transactionToken: string; status: string; settledMinor: number },
): Promise<void> {
  const { db } = deps;
  const [card] = await db
    .select()
    .from(purchaseCards)
    .where(eq(purchaseCards.cardToken, t.cardToken));
  if (!card) return;
  const [approval] = await db
    .select({ amountMinor: cardAuthorizations.amountMinor })
    .from(cardAuthorizations)
    .where(
      and(
        eq(cardAuthorizations.purchaseId, card.purchaseId),
        eq(cardAuthorizations.transactionToken, t.transactionToken),
        eq(cardAuthorizations.approved, true),
      ),
    );
  // Only the transaction both legs approved captures the purchase, and for no more than they
  // approved: anything else is the merchant's to answer for through a chargeback.
  const matches = approval !== undefined && BigInt(t.settledMinor) <= approval.amountMinor;
  if (t.status === "SETTLED" && !matches) {
    deps.log.error(
      { purchaseId: card.purchaseId, transaction: t.transactionToken, settled: t.settledMinor },
      "card settlement does not match the approved authorization",
    );
  }
  if (t.status === "SETTLED" && t.settledMinor > 0 && matches) {
    await db
      .update(purchaseCards)
      .set({
        state: "CLOSED",
        transactionToken: t.transactionToken,
        settledMinor: BigInt(t.settledMinor),
        settledAt: sql`now()`,
      })
      .where(and(eq(purchaseCards.purchaseId, card.purchaseId), eq(purchaseCards.state, "USED")));
    // The network paid the merchant: the charge is collected from the user's PayPal hold. A
    // capture PayPal does not answer now is retried by the pipeline resumer.
    const out = await captureCardStep(deps, card.purchaseId);
    if (out.kind === "final") {
      deps.log.error(
        { purchaseId: card.purchaseId, reason: out.reason },
        "card charge not collected",
      );
    }
  } else if (t.status === "VOIDED" || t.status === "EXPIRED") {
    await db
      .update(purchaseCards)
      .set({ state: "CLOSED" })
      .where(
        and(
          eq(purchaseCards.purchaseId, card.purchaseId),
          inArray(purchaseCards.state, ["PAUSED", "OPEN", "USED"]),
        ),
      );
    const failed = await db
      .update(purchases)
      .set({
        state: "FAILED",
        failureReason: `card:${t.status.toLowerCase()}`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(purchases.id, card.purchaseId), eq(purchases.state, "COVERED")))
      .returning({ id: purchases.id });
    if (failed.length > 0) {
      await publishPurchase(deps, card.purchaseId, {
        type: "purchase.failed",
        step: "card",
        reason: t.status.toLowerCase(),
      });
    }
  }
  if (t.status === "SETTLED" || t.status === "VOIDED") {
    await deps.cards?.issuer.close(t.cardToken).catch((err: unknown) => {
      deps.log.warn({ err, card: t.cardToken }, "card not closed");
    });
  }
}
