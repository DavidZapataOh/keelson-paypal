import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { CurrencyCode, Money } from "@keelson/core";
import {
  and,
  createQueries,
  type Db,
  eq,
  inArray,
  mandates,
  purchaseHolds,
  purchases,
  sql,
} from "@keelson/db";
import { decodeMandate, verifyKeyBinding } from "@keelson/mandate";
import {
  checkAuthorization,
  HoldMismatchError,
  ids,
  purchaseHoldCustomId,
  purchaseHoldDigest,
  purchaseHoldOrderRequest,
} from "@keelson/paypal";
import type { Context } from "hono";
import type { Deps } from "../app.ts";
import { publishEvent } from "../events.ts";
import { voidAuthorization } from "../hold/maintenance.ts";
import { allowedPayees, type MandateRow } from "../hold/state.ts";
import { MERCHANTS } from "../merchants.ts";
import { requireClient, requireSession } from "../middleware/auth.ts";
import { call, type PayPalDeps, paypalProblem } from "../paypal.ts";
import { type Principal, principalChannel } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";

/** Clock skew tolerated on the key binding's `iat`, as the legs tolerate it. */
const MAX_SKEW_SEC = 60;

const problemContent = { "application/problem+json": { schema: ProblemSchema } };
const idempotencyKey = z.object({ "idempotency-key": z.string().min(1).max(255) });
const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const Minor = z.string().regex(/^[1-9]\d{0,17}$/);
const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);

const CreatePurchaseHold = z
  .object({
    requestId: Ulid.openapi({ description: "The request id the purchase is countersigned under." }),
    merchant: z.string().min(1).max(256),
    currency: z.string().length(3),
    amountMinor: Minor.openapi({
      description:
        "The checkout total the purchase is countersigned for, tax and shipping included, in minor units.",
    }),
    cartHash: Hex32,
    closedMandate: z.string().min(1).max(32_768).openapi({
      description:
        "The mandate's open mandate closed by the agent key over `requestId` and `cartHash`; it proves the caller is the mandate's agent.",
    }),
  })
  .openapi("CreatePurchaseHold");

const PurchaseHoldOrder = z
  .object({ requestId: z.string(), orderId: z.string() })
  .openapi("PurchaseHoldOrder");

const AuthorizePurchaseHold = z
  .object({ orderId: z.string().min(1).max(64) })
  .openapi("AuthorizePurchaseHold", { description: "The order the buyer approved." });

const AuthorizedPurchaseHold = z
  .object({
    requestId: z.string(),
    state: z.enum(["AUTHORIZED", "PENDING"]),
    authorizationId: z.string(),
  })
  .openapi("AuthorizedPurchaseHold", {
    description:
      "`PENDING` while PayPal reviews the authorization; asking again once it is created authorizes the hold.",
  });

const create = createRoute({
  method: "post",
  path: "/v1/mandates/{id}/holds",
  tags: ["mandates"],
  summary: "Hold one cart of a multi-merchant mandate",
  description:
    "For a mandate that allows several merchants, creates the PayPal `AUTHORIZE` order for exactly one cart, keyed by the request id it will be countersigned under. The user approves it like a mandate hold.",
  middleware: [requireClient(["countersign:write"])],
  request: {
    params: z.object({ id: z.string() }),
    headers: idempotencyKey,
    body: { required: true, content: { "application/json": { schema: CreatePurchaseHold } } },
  },
  responses: {
    201: {
      description: "The order the buyer approves",
      content: { "application/json": { schema: PurchaseHoldOrder } },
    },
    401: { description: "No valid access token", content: problemContent },
    403: { description: "The caller is not the mandate's agent", content: problemContent },
    404: { description: "No such mandate", content: problemContent },
    409: {
      description:
        "The mandate holds its whole budget, is not active, or the request id is already used",
      content: problemContent,
    },
    422: {
      description:
        "The cart is outside the mandate, its open cart holds with this one exceed the remaining budget, Keelson cannot capture for it, or PayPal refused",
      content: problemContent,
    },
    503: { description: "PayPal is unavailable", content: problemContent },
  },
});

const authorize = createRoute({
  method: "post",
  path: "/v1/mandates/{id}/holds/{requestId}/authorize",
  tags: ["mandates"],
  summary: "Authorize an approved cart hold",
  description:
    "Authorizes the order stored for the request and checks the authorization against it (amount, currency, `custom_id`, payee). An authorization that does not match is voided.",
  middleware: [requireSession()],
  request: {
    params: z.object({ id: z.string(), requestId: z.string() }),
    headers: idempotencyKey,
    body: { required: true, content: { "application/json": { schema: AuthorizePurchaseHold } } },
  },
  responses: {
    200: {
      description: "The cart is held",
      content: { "application/json": { schema: AuthorizedPurchaseHold } },
    },
    202: {
      description: "PayPal holds the authorization as pending",
      content: { "application/json": { schema: AuthorizedPurchaseHold } },
    },
    401: { description: "Not signed in", content: problemContent },
    404: { description: "No such hold for this user", content: problemContent },
    409: {
      description:
        "The mandate is not active, the hold is not pending, or the order is not its order",
      content: problemContent,
    },
    422: {
      description: "The authorization does not match the hold, or PayPal refused",
      content: problemContent,
    },
    503: { description: "PayPal is unavailable", content: problemContent },
  },
});

type PurchaseHoldRow = typeof purchaseHolds.$inferSelect;

function unavailable(c: Context) {
  return problem(c, 503, "paypal-unavailable", "PayPal unavailable", "PayPal is not configured.");
}

function notActive(c: Context) {
  return problem(
    c,
    409,
    "mandate-not-active",
    "Mandate not active",
    "Only an active mandate holds carts.",
  );
}

/** What the mandate's pending and authorized cart holds hold, in minor units. */
async function openHolds(db: Pick<Db, "select">, mandateId: string): Promise<bigint> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${purchaseHolds.amountMinor}), 0)` })
    .from(purchaseHolds)
    .where(
      and(
        eq(purchaseHolds.mandateId, mandateId),
        inArray(purchaseHolds.state, ["PENDING", "AUTHORIZED"]),
      ),
    );
  return BigInt(row?.total ?? 0);
}

function holdDigest(
  mandate: MandateRow,
  hold: Pick<PurchaseHoldRow, "cartHash" | "merchantId" | "currency" | "amountMinor">,
) {
  return purchaseHoldDigest({
    mandateHash: mandate.mandateHash as Buffer,
    cartHash: hold.cartHash,
    merchantId: hold.merchantId,
    amount: { currency: hold.currency as CurrencyCode, minor: hold.amountMinor },
  });
}

export function registerPurchaseHolds(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "log" | "appOrigin" | "paypal">,
): void {
  const { db } = deps;
  const queries = createQueries(db);

  const publish = (mandate: MandateRow, event: Record<string, string>) =>
    publishEvent(
      deps,
      principalChannel({ kind: "user", subject: mandate.userId }, `mandate:${mandate.id}`),
      mandate.id,
      { type: "mandate.purchase_hold", ...event },
    );

  /** Whether Keelson captures for `merchant` under the mandate: its account is the capturing one. */
  const capturable = (paypal: PayPalDeps, mandate: MandateRow, merchant: string) =>
    mandate.merchantIds.includes(merchant) &&
    MERCHANTS.find((m) => m.id === merchant)?.paypal_merchant_id === paypal.merchantId &&
    allowedPayees(mandate).includes(paypal.merchantId);

  app.openapi(create, async (c) => {
    const { paypal } = deps;
    if (!paypal) return unavailable(c);
    const body = c.req.valid("json");
    const mandate = await queries.mandateById(c.req.valid("param").id);
    if (!mandate) return problem(c, 404, "not-found", "Not found");

    const m =
      mandate.payloadSd && mandate.disclosures
        ? decodeMandate(mandate.payloadSd as Record<string, unknown>, mandate.disclosures)
        : undefined;
    const notAgent = () =>
      problem(
        c,
        403,
        "not-mandate-agent",
        "Not the mandate's agent",
        "The closed mandate is not this mandate's, closed by its agent over this request and cart.",
      );
    if (!m || !mandate.openMandate || !body.closedMandate.startsWith(mandate.openMandate)) {
      return notAgent();
    }
    try {
      await verifyKeyBinding(body.closedMandate, m.agent.cnf.jwk, {
        requestId: body.requestId,
        cartHash: `sha256:${body.cartHash.slice(2)}`,
        now: Math.floor(Date.now() / 1000),
        maxSkewSec: MAX_SKEW_SEC,
      });
    } catch {
      return notAgent();
    }

    if (mandate.holdMode !== "per_purchase") {
      return problem(
        c,
        409,
        "mandate-hold-mandate",
        "Mandate holds its budget",
        "This mandate holds its whole budget once; countersign against that hold.",
      );
    }
    if (mandate.state !== "ACTIVE" || mandate.revokeRequestedAt !== null) return notActive(c);
    if (!capturable(paypal, mandate, body.merchant)) {
      return problem(
        c,
        422,
        "merchant-not-capturable",
        "Merchant not capturable",
        "The merchant is not one the mandate allows and Keelson captures for.",
      );
    }
    if (body.currency !== mandate.currency) {
      return problem(
        c,
        422,
        "currency-mismatch",
        "Currency mismatch",
        "The mandate's currency differs.",
      );
    }
    const amount: Money = {
      currency: mandate.currency as CurrencyCode,
      minor: BigInt(body.amountMinor),
    };
    const range = m.payment.constraints.find((x) => x.type === "payment.amount_range");
    if (
      amount.minor > mandate.remainingMinor ||
      (range?.type === "payment.amount_range" && amount.minor > BigInt(range.max))
    ) {
      return problem(
        c,
        422,
        "amount-exceeds-mandate",
        "Amount exceeds the mandate",
        "The cart total is above the mandate's remaining budget or its largest purchase.",
      );
    }

    const hold = {
      requestId: body.requestId,
      mandateId: mandate.id,
      merchantId: body.merchant,
      currency: amount.currency,
      amountMinor: amount.minor,
      cartHash: Buffer.from(body.cartHash.slice(2), "hex"),
    };
    const same = (r: PurchaseHoldRow | undefined) =>
      r !== undefined &&
      r.mandateId === hold.mandateId &&
      r.merchantId === hold.merchantId &&
      r.currency === hold.currency &&
      r.amountMinor === hold.amountMinor &&
      r.cartHash.equals(hold.cartHash);
    const created = (orderId: string) => c.json({ requestId: hold.requestId, orderId }, 201);
    const used = () =>
      problem(c, 409, "request-exists", "Request exists", "This request id was already used.");
    const stored = async () =>
      (await db.select().from(purchaseHolds).where(eq(purchaseHolds.requestId, hold.requestId)))[0];

    const [existing, [purchase]] = await Promise.all([
      stored(),
      db.select({ id: purchases.id }).from(purchases).where(eq(purchases.id, hold.requestId)),
    ]);
    if (existing) return same(existing) ? created(existing.paypalOrderId) : used();
    if (purchase) return used();

    const overBudget = () =>
      problem(
        c,
        422,
        "holds-exceed-budget",
        "Holds exceed the budget",
        "The mandate's pending and authorized cart holds with this one exceed its remaining budget.",
      );
    if ((await openHolds(db, mandate.id)) + amount.minor > mandate.remainingMinor) {
      return overBudget();
    }

    const merchant = MERCHANTS.find((x) => x.id === hold.merchantId);
    if (deps.appOrigin === undefined) throw new Error("appOrigin is required to hold carts");
    const url = `${deps.appOrigin}/mandates/${mandate.id}`;
    const order = purchaseHoldOrderRequest({
      env: paypal.env,
      requestId: hold.requestId,
      digest: holdDigest(mandate, hold),
      amount,
      mid: mandate.id,
      merchantName: merchant?.name ?? hold.merchantId,
      returnUrl: url,
      cancelUrl: url,
    });
    let orderId: string;
    try {
      const res = await call(
        paypal.paypal.orders.createOrder({
          paypalRequestId: order.paypalRequestId,
          body: order.body,
        }),
      );
      if (!res.id) throw new Error("PayPal created an order without an id");
      orderId = res.id;
    } catch (err) {
      const answer = paypalProblem(c, err);
      if (answer) return answer;
      throw err;
    }
    // The budget is checked again under the mandate's row lock, so concurrent holds cannot
    // together exceed it.
    const inserted = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ remainingMinor: mandates.remainingMinor })
        .from(mandates)
        .where(eq(mandates.id, mandate.id))
        .for("update");
      const [again] = await tx
        .select({ requestId: purchaseHolds.requestId })
        .from(purchaseHolds)
        .where(eq(purchaseHolds.requestId, hold.requestId));
      if (
        again === undefined &&
        (await openHolds(tx, mandate.id)) + amount.minor > (locked?.remainingMinor ?? 0n)
      ) {
        return null;
      }
      return tx
        .insert(purchaseHolds)
        .values({ ...hold, paypalOrderId: orderId, state: "PENDING" })
        .onConflictDoNothing({ target: purchaseHolds.requestId })
        .returning({ requestId: purchaseHolds.requestId });
    });
    if (inserted === null) return overBudget();
    if (inserted.length === 0) {
      // A concurrent request for the same request id created the same order first.
      const now = await stored();
      return same(now) && now?.paypalOrderId === orderId ? created(orderId) : used();
    }
    await publish(mandate, {
      state: "PENDING",
      requestId: hold.requestId,
      orderId,
      merchant: hold.merchantId,
      amountMinor: hold.amountMinor.toString(),
    });
    return created(orderId);
  });

  app.openapi(authorize, async (c) => {
    const { paypal } = deps;
    if (!paypal) return unavailable(c);
    const { id, requestId } = c.req.valid("param");
    const { orderId } = c.req.valid("json");
    const mandate = await queries.mandateById(id);
    const userId = (c.get("principal") as Principal).subject;
    const [hold] =
      mandate && mandate.userId === userId
        ? await db
            .select()
            .from(purchaseHolds)
            .where(and(eq(purchaseHolds.requestId, requestId), eq(purchaseHolds.mandateId, id)))
        : [];
    if (!mandate || !hold) return problem(c, 404, "not-found", "Not found");
    const answer = (authorizationId: string, state: "AUTHORIZED" | "PENDING") =>
      c.json({ requestId, state, authorizationId }, state === "AUTHORIZED" ? 200 : 202);

    if (hold.state === "AUTHORIZED" && hold.paypalOrderId === orderId && hold.paypalAuthorizationId)
      return answer(hold.paypalAuthorizationId, "AUTHORIZED");
    if (hold.state !== "PENDING") {
      return problem(
        c,
        409,
        "hold-not-pending",
        "Hold not pending",
        "The hold is not waiting for authorization.",
      );
    }
    if (orderId !== hold.paypalOrderId) {
      return problem(
        c,
        409,
        "order-mismatch",
        "Order mismatch",
        "The order is not the one held for this request.",
      );
    }
    // Funds authorized for a mandate that is ending would stay held until PayPal expires them.
    if (mandate.state !== "ACTIVE" || mandate.revokeRequestedAt !== null) return notActive(c);

    try {
      const authorized = await call(
        paypal.paypal.orders.authorizeOrder({
          id: orderId,
          paypalRequestId: ids.operationRequestId(orderId, "authorize"),
        }),
      );
      const authorizationId =
        authorized.purchaseUnits?.[0]?.payments?.authorizations?.[0]?.id ?? undefined;
      if (!authorizationId) throw new Error(`PayPal authorized order ${orderId} without an id`);
      // Moves the hold only while the mandate still holds carts.
      const pendingUnderLiveMandate = and(
        eq(purchaseHolds.requestId, requestId),
        eq(purchaseHolds.state, "PENDING"),
        sql`exists (select 1 from ${mandates} where ${mandates.id} = ${id} and ${mandates.state} = 'ACTIVE' and ${mandates.revokeRequestedAt} is null)`,
      );
      // The mandate ended, or the hold moved on, while PayPal authorized: nothing may stay held.
      const lost = async () => {
        const [now] = await db
          .select()
          .from(purchaseHolds)
          .where(eq(purchaseHolds.requestId, requestId));
        if (now?.state === "AUTHORIZED" && now.paypalAuthorizationId === authorizationId)
          return answer(authorizationId, "AUTHORIZED");
        await voidAuthorization(paypal, authorizationId);
        await db
          .update(purchaseHolds)
          .set({ state: "VOIDED", updatedAt: sql`now()` })
          .where(and(eq(purchaseHolds.requestId, requestId), eq(purchaseHolds.state, "PENDING")));
        return problem(
          c,
          409,
          "hold-not-pending",
          "Hold not pending",
          "The mandate ended, or the hold left PENDING, while it was authorized; the authorization was voided.",
        );
      };
      const auth = await call(paypal.paypal.payments.getAuthorizedPayment({ authorizationId }));
      if (auth.status === "PENDING") {
        // Stored so that a void before the hold is authorized finds it.
        const stored = await db
          .update(purchaseHolds)
          .set({ paypalAuthorizationId: authorizationId, updatedAt: sql`now()` })
          .where(pendingUnderLiveMandate);
        if (stored.rowCount !== 1) return await lost();
        return answer(authorizationId, "PENDING");
      }
      try {
        checkAuthorization(auth, {
          customId: purchaseHoldCustomId(paypal.env, requestId, holdDigest(mandate, hold)),
          amount: { currency: hold.currency as CurrencyCode, minor: hold.amountMinor },
          payees: allowedPayees(mandate).filter((p) => p === paypal.merchantId),
        });
      } catch (err) {
        if (!(err instanceof HoldMismatchError)) throw err;
        deps.log.warn({ requestId, authorizationId, field: err.field }, "purchase hold mismatch");
        await voidAuthorization(paypal, authorizationId);
        await db
          .update(purchaseHolds)
          .set({ state: "VOIDED", updatedAt: sql`now()` })
          .where(and(eq(purchaseHolds.requestId, requestId), eq(purchaseHolds.state, "PENDING")));
        return problem(
          c,
          422,
          "hold-mismatch",
          "Hold mismatch",
          `The authorization's ${err.field} does not match the hold; it was voided.`,
          { field: err.field },
        );
      }
      const moved = await db
        .update(purchaseHolds)
        .set({ state: "AUTHORIZED", paypalAuthorizationId: authorizationId, updatedAt: sql`now()` })
        .where(pendingUnderLiveMandate);
      if (moved.rowCount !== 1) return await lost();
      await publish(mandate, { state: "AUTHORIZED", requestId, orderId, authorizationId });
      return answer(authorizationId, "AUTHORIZED");
    } catch (err) {
      const answer = paypalProblem(c, err);
      if (answer) return answer;
      throw err;
    }
  });
}
