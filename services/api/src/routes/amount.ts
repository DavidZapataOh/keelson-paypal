import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  type AmountCheck,
  AmountMismatch,
  amountConfirmChallenge,
  type CheckoutTotal,
  type CurrencyCode,
  checkoutTotal,
  compareOrder,
  orderFacts,
  orderIdHash,
  toPayPalValue,
} from "@keelson/core";
import { eq, mandates, passkey, purchases, type StoredAmountConfirm, sql } from "@keelson/db";
import { allowedPayees, decodeMandate, type Mandate, payeeAllowed, RP_ID } from "@keelson/mandate";
import { PayPalError } from "@keelson/paypal";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { Context } from "hono";
import type { Deps } from "../app.ts";
import { breakdowns } from "../checkout.ts";
import { SignatureError, verifyPasskeyAssertion } from "../mandate-signature.ts";
import { requireClient, requireSession } from "../middleware/auth.ts";
import { money, notify } from "../notify/notifier.ts";
import { ProblemSchema, problem } from "../problem.ts";

/** How long the user has to confirm an amount before the purchase ends blocked. */
const CONFIRM_TTL_MS = 10 * 60_000;
const ORDER_TOKEN = /^(?:EC-)?[0-9A-Z]{17}$/;
const PAYEE = /^[0-9A-Z]{8,20}$/;

const Id = z.string().length(26);
const problemContent = { "application/problem+json": { schema: ProblemSchema } };

const AmountCheckSchema = z
  .object({
    v: z.literal("keelson.amount_check/1"),
    authority: z.enum(["paypal_order", "merchant_signed_cart", "user_confirmed", "checkout_page"]),
    via: z.enum(["own", "partner", "ucp"]).optional(),
    read_by: z.enum(["api", "tee:A"]),
    order_id_hash: z.string().regex(/^0x[0-9a-f]{64}$/),
    total: z.object({ currency: z.string(), minor: z.number().int() }),
    payee: z.string(),
    intent: z.enum(["CAPTURE", "AUTHORIZE"]),
    checked_at: z.string(),
    cross_check: z.enum(["agrees", "unavailable"]),
    evidence: z
      .object({
        assertion: z
          .object({
            credentialId: z.string(),
            authenticatorData: z.string(),
            clientDataJSON: z.string(),
            signature: z.string(),
          })
          .optional(),
      })
      .optional(),
  })
  .openapi("AmountCheck", {
    description:
      "What decided a live checkout's amount: PayPal's Orders API (`paypal_order`), the store's signature (`merchant_signed_cart`) or the user's passkey (`user_confirmed`). `checkout_page` is never an authority.",
  });

const checkRoute = createRoute({
  method: "post",
  path: "/v1/purchases/{id}/amount-check",
  operationId: "checkPurchaseAmount",
  tags: ["purchases"],
  summary: "Decide a live checkout's amount before the pay click",
  description:
    "For a live purchase Keelson allowed, right before the agent pays PayPal's order `orderId`. Keelson reads the order with PayPal's Orders API (`GET /v2/checkout/orders/{id}`) and answers `200` when it charges exactly the countersigned total to a payee the mandate names. When Keelson cannot read the order, the user confirms the amount with their passkey: the first call answers `202` and sends the confirmation to their phone, and later calls answer `202` until they confirm (`200`), decline (`409 amount-declined`) or let it expire (`410`). `crossCheck` is what PayPal's checkout stated for the same order; `disagrees` always holds. Decided once per purchase; only the client that asked for the countersign may call it.",
  middleware: [requireClient(["countersign:write"])],
  request: {
    params: z.object({ id: Id }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              orderId: z.string().regex(ORDER_TOKEN),
              crossCheck: z.enum(["agrees", "unavailable", "disagrees"]),
              order: z
                .object({
                  intent: z.enum(["SALE", "AUTHORIZE"]),
                  payee: z.string().regex(PAYEE),
                })
                .optional()
                .openapi({
                  description:
                    "The order's intent and payee as PayPal's checkout stated them, when it did.",
                }),
            })
            .openapi("AmountCheckRequest"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "An authority decided the amount",
      content: { "application/json": { schema: AmountCheckSchema } },
    },
    202: {
      description: "The user is asked to confirm the amount on their phone",
      content: {
        "application/json": {
          schema: z.object({
            needs: z.literal("user_confirmed"),
            expiresAt: z.string(),
          }),
        },
      },
    },
    404: { description: "No such live purchase of this client", content: problemContent },
    409: {
      description:
        "PayPal's order does not charge the countersigned total (`amount-mismatch`, with `field`), another order was decided for this purchase, or the user declined",
      content: problemContent,
    },
    410: { description: "The user did not confirm in time", content: problemContent },
    503: { description: "PayPal did not answer", content: problemContent },
  },
});

const Assertion = z.object({
  authenticatorData: z.string(),
  clientDataJSON: z.string(),
  signature: z.string(),
  credentialId: z.string(),
  userHandle: z.string().optional(),
});

const Confirmation = z
  .object({
    purchaseId: z.string(),
    store: z.string(),
    payee: z.string(),
    total: z.object({ currency: z.string(), minor: z.string() }),
    intent: z.enum(["CAPTURE", "AUTHORIZE"]),
    state: z.enum(["PENDING", "CONFIRMED", "DECLINED", "EXPIRED"]),
    expiresAt: z.string(),
    challenge: z.string().openapi({ description: "The WebAuthn challenge, base64url." }),
    credentialId: z.string().openapi({ description: "The passkey that signed the mandate." }),
    spc: z.object({
      payeeName: z.string(),
      payeeOrigin: z.string(),
      total: z.object({ currency: z.string(), value: z.string() }),
    }),
  })
  .openapi("AmountConfirmation");

const getConfirmRoute = createRoute({
  method: "get",
  path: "/v1/purchases/{id}/amount-confirmation",
  operationId: "getAmountConfirmation",
  tags: ["purchases"],
  summary: "The amount the user is asked to confirm",
  middleware: [requireSession()],
  request: { params: z.object({ id: Id }) },
  responses: {
    200: {
      description: "The confirmation",
      content: { "application/json": { schema: Confirmation } },
    },
    404: { description: "No confirmation for this user", content: problemContent },
  },
});

const answerRoute = createRoute({
  method: "post",
  path: "/v1/purchases/{id}/amount-confirmation",
  operationId: "answerAmountConfirmation",
  tags: ["purchases"],
  summary: "Confirm or decline a live checkout's amount",
  description:
    'Confirms the amount with the passkey that signed the mandate: a WebAuthn or Secure Payment Confirmation assertion over `SHA-256("keelson/amount-confirm/v1" || 0x00 || JCS({purchase_id, order_id_hash, currency, minor, payee}))`. Or declines it, and the agent does not pay.',
  middleware: [requireSession()],
  request: {
    params: z.object({ id: Id }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.union([
            z.object({ assertion: Assertion }),
            z.object({ decline: z.literal(true) }),
          ]),
        },
      },
    },
  },
  responses: {
    200: { description: "The answer", content: { "application/json": { schema: Confirmation } } },
    401: { description: "The assertion does not verify", content: problemContent },
    404: { description: "No confirmation for this user", content: problemContent },
    409: { description: "Already answered", content: problemContent },
    410: { description: "Expired", content: problemContent },
  },
});

type Row = typeof purchases.$inferSelect;

/** The countersigned total of a purchase, with its breakdown when its evidence binds one. */
async function countersigned(db: Deps["db"], row: Row): Promise<CheckoutTotal> {
  const found = await breakdowns(db, [row.evidenceRoot]);
  const b = row.evidenceRoot ? found.get(row.evidenceRoot.toString("hex")) : undefined;
  return b
    ? checkoutTotal(row.currency, {
        items: Number(b.items),
        tax: Number(b.tax),
        shipping: Number(b.shipping),
        discount: Number(b.discount),
      })
    : checkoutTotal(row.currency, { items: Number(row.amountMinor) });
}

async function mandateOf(
  db: Deps["db"],
  mandateId: string,
): Promise<{ m: Mandate; userId: string }> {
  const [r] = await db
    .select({
      payloadSd: mandates.payloadSd,
      disclosures: mandates.disclosures,
      userId: mandates.userId,
    })
    .from(mandates)
    .where(eq(mandates.id, mandateId));
  if (!r?.payloadSd || !r.disclosures) throw new Error("the mandate is not signed");
  return { m: decodeMandate(r.payloadSd, r.disclosures), userId: r.userId };
}

/** The SPC dialog of an amount confirmation: the store as payee, the order's total. */
function spcOf(store: string, a: StoredAmountConfirm) {
  return {
    payeeName: URL.parse(store)?.hostname ?? store,
    payeeOrigin: URL.parse(store)?.origin ?? store,
    total: {
      currency: a.currency,
      value: toPayPalValue({ currency: a.currency as CurrencyCode, minor: BigInt(a.minor) }),
    },
  };
}

const expired = (a: StoredAmountConfirm, now = Date.now()) => Date.parse(a.expires_at) <= now;

export function registerAmount(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "paypal" | "notifier" | "appOrigin" | "passkeyRpId">,
): void {
  const { db } = deps;

  app.openapi(checkRoute, async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const [row] = await db.select().from(purchases).where(eq(purchases.id, id));
    if (
      !row ||
      row.clientId !== c.var.principal?.subject ||
      row.liveStore === null ||
      row.decision !== 1
    ) {
      return problem(c, 404, "not-found", "Not found");
    }
    const hash = orderIdHash(body.orderId);
    const mismatch = (field: string) =>
      problem(
        c,
        409,
        "amount-mismatch",
        "Amount mismatch",
        `PayPal's order does not match what Keelson countersigned (${field}).`,
        { field },
      );
    if (body.crossCheck === "disagrees") return mismatch("order");
    const stored = row.amountCheck as AmountCheck | null;
    if (stored) {
      if (stored.order_id_hash !== hash) return otherOrder(c);
      return c.json(stored as z.infer<typeof AmountCheckSchema>, 200);
    }
    const total = await countersigned(db, row);
    const { m, userId } = await mandateOf(db, row.mandateId);
    const payees = allowedPayees(m);
    const allowed = (p: string) => payeeAllowed(payees, p);
    const crossCheck = body.crossCheck;

    // Keelson's own credentials read only orders its PayPal app created; any other is not found.
    let order: unknown;
    if (deps.paypal) {
      try {
        order = await deps.paypal.paypal.fetch("GET", `/v2/checkout/orders/${body.orderId}`);
      } catch (err) {
        if (!(err instanceof PayPalError) || (err.status !== 404 && err.status !== 403)) {
          return problem(c, 503, "paypal-unavailable", "PayPal unavailable", "Paying waits.");
        }
      }
    }
    if (order !== undefined) {
      try {
        const facts = orderFacts(order);
        if (facts.orderId !== body.orderId.replace(/^EC-/, "")) throw new AmountMismatch("order");
        compareOrder(facts, total, allowed);
        const check: AmountCheck = {
          v: "keelson.amount_check/1",
          authority: "paypal_order",
          via: "own",
          read_by: "api",
          order_id_hash: hash,
          total: { currency: facts.currency, minor: facts.total.minor },
          payee: facts.payee,
          intent: facts.intent,
          checked_at: new Date().toISOString(),
          cross_check: crossCheck,
        };
        return decided(c, id, hash, check);
      } catch (err) {
        if (err instanceof AmountMismatch) return mismatch(err.field);
        throw err;
      }
    }

    // No documented PayPal read of this order: the user confirms the amount with their passkey.
    const pending = row.amountConfirm;
    if (pending) {
      if (pending.order_id_hash !== hash) return otherOrder(c);
      if (pending.state === "DECLINED") {
        return problem(
          c,
          409,
          "amount-declined",
          "Amount declined",
          "The user declined this amount. Do not pay.",
        );
      }
      if (expired(pending)) {
        return problem(
          c,
          410,
          "amount-confirmation-expired",
          "Confirmation expired",
          "The user did not confirm in time. Do not pay.",
        );
      }
      return c.json({ needs: "user_confirmed" as const, expiresAt: pending.expires_at }, 202);
    }
    const payee =
      body.order && allowed(body.order.payee)
        ? body.order.payee
        : payees.length === 1 && allowed(payees[0] as string)
          ? (payees[0] as string)
          : undefined;
    if (payee === undefined) return mismatch("payee");
    const ask: StoredAmountConfirm = {
      order_id_hash: hash,
      currency: total.currency,
      minor: total.minor,
      payee,
      intent: body.order?.intent === "AUTHORIZE" ? "AUTHORIZE" : "CAPTURE",
      cross_check: crossCheck,
      state: "PENDING",
      expires_at: new Date(Date.now() + CONFIRM_TTL_MS).toISOString(),
    };
    const [set] = await db
      .update(purchases)
      .set({ amountConfirm: ask })
      .where(sql`${purchases.id} = ${id} and ${purchases.amountConfirm} is null`)
      .returning({ id: purchases.id });
    if (set) {
      const store = row.liveStore;
      notify(deps.notifier, async (n) => ({
        userId,
        alert: {
          event: "amount.confirm",
          title: `Confirm ${money(String(ask.minor), ask.currency)} at ${URL.parse(store)?.hostname ?? store}`,
          body: "Your agent is about to pay with PayPal. Keelson could not confirm this amount with PayPal for this store.",
          url: `${n.appOrigin}/amount/?id=${id}`,
          action: "Confirm the amount",
          push: { ttl: CONFIRM_TTL_MS / 1000, urgency: "high" },
          subjectId: id,
        },
      }));
    }
    return c.json({ needs: "user_confirmed" as const, expiresAt: ask.expires_at }, 202);
  });

  /** Stores the purchase's amount check once; a check of another order answers 409. */
  async function decided(c: Context, id: string, hash: string, check: AmountCheck) {
    const [set] = await db
      .update(purchases)
      .set({ amountCheck: check as unknown as Record<string, unknown> })
      .where(sql`${purchases.id} = ${id} and ${purchases.amountCheck} is null`)
      .returning({ amountCheck: purchases.amountCheck });
    const now = (set?.amountCheck ??
      (await db.select({ a: purchases.amountCheck }).from(purchases).where(eq(purchases.id, id)))[0]
        ?.a) as AmountCheck | null;
    if (now?.order_id_hash !== hash) return otherOrder(c);
    return c.json(now, 200);
  }

  function otherOrder(c: Context) {
    return problem(
      c,
      409,
      "amount-order-changed",
      "Another order",
      "Keelson decided this purchase's amount for another PayPal order. Paying waits.",
    );
  }

  /** The purchase's pending confirmation, if the signed-in user owns it. */
  async function ownConfirmation(c: Context, id: string) {
    const [r] = await db
      .select({ purchase: purchases, userId: mandates.userId })
      .from(purchases)
      .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
      .where(eq(purchases.id, id));
    if (!r?.purchase.amountConfirm || r.purchase.liveStore === null) return undefined;
    if (r.userId !== c.var.principal?.subject) return undefined;
    return { row: r.purchase, ask: r.purchase.amountConfirm, store: r.purchase.liveStore };
  }

  async function view(row: Row, ask: StoredAmountConfirm, store: string) {
    const { m } = await mandateOf(db, row.mandateId);
    const challenge = amountConfirmChallenge({
      purchase_id: row.id,
      order_id_hash: ask.order_id_hash,
      currency: ask.currency,
      minor: ask.minor,
      payee: ask.payee,
    });
    return {
      purchaseId: row.id,
      store,
      payee: ask.payee,
      total: { currency: ask.currency, minor: String(ask.minor) },
      intent: ask.intent,
      state: ask.state === "PENDING" && expired(ask) ? ("EXPIRED" as const) : ask.state,
      expiresAt: ask.expires_at,
      challenge: isoBase64URL.fromBuffer(new Uint8Array(challenge)),
      credentialId: m.user.cred.id,
      spc: spcOf(store, ask),
    };
  }

  app.openapi(getConfirmRoute, async (c) => {
    const own = await ownConfirmation(c, c.req.valid("param").id);
    if (!own) return problem(c, 404, "not-found", "Not found");
    c.header("Cache-Control", "no-store");
    return c.json(await view(own.row, own.ask, own.store), 200);
  });

  app.openapi(answerRoute, async (c) => {
    const id = c.req.valid("param").id;
    const body = c.req.valid("json");
    const own = await ownConfirmation(c, id);
    if (!own) return problem(c, 404, "not-found", "Not found");
    const { row, ask, store } = own;
    if (ask.state !== "PENDING") {
      return problem(
        c,
        409,
        "answered",
        "Already answered",
        `This amount is already ${ask.state.toLowerCase()}.`,
      );
    }
    if (expired(ask)) return problem(c, 410, "expired", "Expired", "Your agent stopped waiting.");
    if ("decline" in body) {
      const [set] = await db
        .update(purchases)
        .set({ amountConfirm: { ...ask, state: "DECLINED" } })
        .where(sql`${purchases.id} = ${id} and ${purchases.amountConfirm}->>'state' = 'PENDING'`)
        .returning();
      if (!set?.amountConfirm) return problem(c, 409, "answered", "Already answered");
      return c.json(await view(set, set.amountConfirm, store), 200);
    }
    const { m } = await mandateOf(db, row.mandateId);
    const { userHandle, ...signed } = body.assertion;
    const assertion = userHandle === undefined ? signed : { ...signed, userHandle };
    const key = await db.query.passkey.findFirst({
      where: (r, { eq }) => eq(r.credentialID, assertion.credentialId),
    });
    const invalid = () =>
      problem(
        c,
        401,
        "invalid-signature",
        "Invalid signature",
        "The passkey signature does not verify for this amount.",
      );
    if (!key || key.credentialID !== m.user.cred.id || key.userId !== c.var.principal?.subject) {
      return invalid();
    }
    const origin = deps.appOrigin;
    if (origin === undefined) throw new Error("appOrigin is required to verify confirmations");
    let newCounter: number;
    try {
      ({ newCounter } = await verifyPasskeyAssertion({
        challenge: amountConfirmChallenge({
          purchase_id: row.id,
          order_id_hash: ask.order_id_hash,
          currency: ask.currency,
          minor: ask.minor,
          payee: ask.payee,
        }),
        assertion,
        passkey: key,
        expectedOrigin: origin,
        expectedRpId: deps.passkeyRpId ?? RP_ID,
        spc: spcOf(store, ask),
      }));
    } catch (err) {
      if (err instanceof SignatureError) return invalid();
      throw err;
    }
    const check: AmountCheck = {
      v: "keelson.amount_check/1",
      authority: "user_confirmed",
      read_by: "api",
      order_id_hash: ask.order_id_hash,
      total: { currency: ask.currency, minor: ask.minor },
      payee: ask.payee,
      intent: ask.intent,
      checked_at: new Date().toISOString(),
      cross_check: ask.cross_check,
      evidence: {
        assertion: {
          credentialId: assertion.credentialId,
          authenticatorData: assertion.authenticatorData,
          clientDataJSON: assertion.clientDataJSON,
          signature: assertion.signature,
        },
      },
    };
    const set = await db.transaction(async (tx) => {
      const counted = await tx
        .update(passkey)
        .set({ counter: newCounter })
        .where(
          sql`${passkey.id} = ${key.id} and (${newCounter} = 0 or ${passkey.counter} < ${newCounter})`,
        );
      if (counted.rowCount !== 1) return undefined;
      const [r] = await tx
        .update(purchases)
        .set({
          amountConfirm: { ...ask, state: "CONFIRMED" },
          amountCheck: check as unknown as Record<string, unknown>,
        })
        .where(
          sql`${purchases.id} = ${id} and ${purchases.amountConfirm}->>'state' = 'PENDING' and ${purchases.amountCheck} is null`,
        )
        .returning();
      return r;
    });
    if (!set?.amountConfirm) return invalid();
    return c.json(await view(set, set.amountConfirm, store), 200);
  });
}
