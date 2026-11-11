import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  alibis,
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  like,
  mandates,
  or,
  purchaseCards,
  purchases,
  type SQL,
  user,
} from "@keelson/db";
import type { Deps } from "../app.ts";
import { Amount, breakdowns, withBreakdown } from "../checkout.ts";
import { requireClient, requirePrincipal } from "../middleware/auth.ts";
import { cardViewOf, failedFields, type PurchaseView, purchaseView } from "../pipeline/drive.ts";
import { ProblemSchema, problem } from "../problem.ts";

/** How far the purchase got after its countersign. */
export const PurchaseProgress = z.object({
  state: z.string().optional().openapi({
    description:
      "`CAPTURED` once logged, covered and captured; `FAILED` with `failure` when a step refused; `COUNTERSIGNED`, `LOGGED` or `COVERED` while a step is pending; `DENIED` for a DENY.",
  }),
  logIndex: z.string().optional().openapi({ description: "The leaf's index in the Alibi log." }),
  coverage: z
    .object({ chainId: z.number().int(), txHash: z.string().nullable() })
    .optional()
    .openapi({ description: "The `lockCoverage` transaction of the operator's bond." }),
  capture: z
    .object({ id: z.string(), invoiceId: z.string(), status: z.string().nullable() })
    .optional()
    .openapi({ description: "The PayPal capture of the countersigned amount." }),
  failure: z
    .object({ step: z.string(), reason: z.string() })
    .optional()
    .openapi({ description: "The step that failed and why; nothing was captured." }),
  blocked: z
    .array(z.string())
    .optional()
    .openapi({ description: "For a `DENIED` cart, the mandate fields whose check failed." }),
  reasons: z
    .array(
      z.object({ field: z.string(), mandate: z.string().nullable(), cart: z.string().nullable() }),
    )
    .optional()
    .openapi({
      description:
        "For a `DENIED` cart, each failed field with what the mandate allowed and what the cart had, as text.",
    }),
  checks: z
    .array(
      z.object({
        field: z.string(),
        mandate: z.string().nullable(),
        cart: z.string().nullable(),
        pass: z.boolean(),
      }),
    )
    .optional()
    .openapi({
      description:
        "For a purchase the engine checked, each mandate field with what the mandate allowed, what the cart had and whether it held.",
    }),
  card: z
    .object({
      issuer: z.string(),
      lastFour: z.string(),
      state: z.string(),
      expiresAt: z.string(),
      controls: z.record(z.string(), z.unknown()),
      settledMinor: z.string().nullable(),
      chargebacks: z.array(z.record(z.string(), z.unknown())).openapi({
        description: "Chargebacks filed through the card issuer over this purchase.",
      }),
      bondClaimMinor: z.string().openapi({
        description:
          "The most a bond claim over this purchase may pay: the settled amount less what chargebacks returned; 0 while one is open.",
      }),
      authorizations: z.array(
        z.object({
          id: z.string(),
          amountMinor: z.string(),
          currency: z.string(),
          mcc: z.string(),
          merchantName: z.string(),
          merchantCountry: z.string(),
          approved: z.boolean(),
          failedMask: z.number().int(),
          reason: z.string().nullable(),
          legs: z.object({ tdx: z.boolean(), nitro: z.boolean() }),
          latencyMs: z.number().int(),
          at: z.string(),
        }),
      ),
    })
    .optional()
    .openapi({
      description:
        "A card purchase: its single-use card (never its number) and every authorization the card network sent it, with both legs' decision. `CAPTURED` once the merchant's capture settles.",
    }),
  live: z.object({ store: z.string(), transactionId: z.string().nullable() }).optional().openapi({
    description:
      "A purchase the buyer pays at the store's own checkout: the store's origin and the PayPal transaction id once the agent recorded it. Never covered nor captured.",
  }),
});

export function progressOf(view: PurchaseView | undefined): z.infer<typeof PurchaseProgress> {
  if (!view) return {};
  const { state, logIndex, coverage, capture, failure, blocked, reasons, checks, live, card } =
    view;
  return {
    state,
    ...(logIndex ? { logIndex } : {}),
    ...(coverage ? { coverage } : {}),
    ...(capture ? { capture } : {}),
    ...(failure ? { failure } : {}),
    ...(blocked ? { blocked } : {}),
    ...(reasons ? { reasons } : {}),
    ...(checks ? { checks } : {}),
    ...(live ? { live } : {}),
    ...(card ? { card } : {}),
  };
}

const Purchase = z
  .object({
    id: z.string(),
    mandateId: z.string(),
    mode: z.enum(["2of2", "degraded"]).nullable(),
    amount: Amount,
    ...PurchaseProgress.shape,
    state: z.string(),
  })
  .openapi("Purchase");

const route = createRoute({
  method: "get",
  path: "/v1/purchases/{id}",
  operationId: "getPurchase",
  tags: ["purchases"],
  summary: "A purchase",
  description:
    "The purchase's state: its log index, its coverage and its capture once each is recorded. Readable by the mandate's owner and by the client that asked for the countersign; an app acting for a user, only for that user.",
  middleware: [requirePrincipal()],
  request: { params: z.object({ id: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/) }) },
  responses: {
    200: { description: "The purchase", content: { "application/json": { schema: Purchase } } },
    404: {
      description: "No such purchase, or not the caller's",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const problemContent = { "application/problem+json": { schema: ProblemSchema } };
const Id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

const transactionRoute = createRoute({
  method: "put",
  path: "/v1/purchases/{id}/paypal-transaction",
  operationId: "recordPayPalTransaction",
  tags: ["purchases"],
  summary: "Record a live purchase's PayPal transaction",
  description:
    "For a purchase countersigned with `live`, once its Alibi is issued: the PayPal transaction id of the buyer's payment at the store, as PayPal reported it on its confirmation. Recorded once; the Alibi carries it from then on, marked as not signed. Only the client that asked for the countersign records it.",
  middleware: [requireClient(["countersign:write"])],
  request: {
    params: z.object({ id: Id }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              transactionId: z
                .string()
                .regex(/^[0-9A-Z]{17}$/)
                .openapi({ description: "PayPal's 17-character transaction id." }),
            })
            .openapi("PayPalTransaction"),
        },
      },
    },
  },
  responses: {
    200: { description: "The purchase", content: { "application/json": { schema: Purchase } } },
    404: { description: "No such purchase of this client", content: problemContent },
    409: {
      description:
        "The purchase is not live, its Alibi is not issued yet, or another transaction id is recorded",
      content: problemContent,
    },
  },
});

const LivePurchase = z
  .object({
    id: z.string().openapi({ description: "The purchase and its Alibi's id." }),
    store: z.string().nullable().openapi({
      description: "The store's origin; `null` for a card purchase, named by the card network.",
    }),
    merchant: z.string(),
    amount: Amount,
    decision: z.enum(["allow", "deny"]),
    transactionId: z.string().nullable().openapi({
      description: "The PayPal transaction the store was paid by; `null` for a DENY.",
    }),
    blocked: z.array(z.string()).openapi({
      description:
        "For a DENY, the mandate fields whose check failed, or leg A's reason when it denied on its read of the PayPal hold.",
    }),
    card: z
      .object({
        lastFour: z.string(),
        merchantName: z.string().nullable(),
        mcc: z.string().nullable(),
        approved: z.number().int(),
        declined: z.number().int(),
        settledMinor: z.string().nullable(),
      })
      .optional()
      .openapi({
        description:
          "A card purchase: the merchant as the card network named it, and how many of the card's authorizations both legs approved and declined.",
      }),
    logIndex: z.string(),
    createdAt: z.string(),
  })
  .openapi("LivePurchase");

/**
 * The card purchases whose Alibi is public: those Keelson's own demo operator made for one of its
 * test users, on the reserved `example.test` domain, or for a Judge Mode tenant, which is
 * anonymous.
 */
export function publicCard(demoAgentId: bigint | undefined): SQL | undefined {
  return demoAgentId === undefined
    ? undefined
    : and(
        eq(purchases.rail, "card"),
        eq(mandates.operatorAgentId, demoAgentId),
        or(like(user.email, "%@example.test"), like(user.email, "%@judge.keelson.finance")),
      );
}

/**
 * The live carts Keelson denied whose Alibi is public: Keelson's own demo operator ran them for
 * one of its test users, whose addresses are on the reserved `example.test` domain (RFC 2606). An
 * Alibi carries the user's mandate, so a real user's DENY is never published.
 */
export function publicDenial(demoAgentId: bigint | undefined): SQL | undefined {
  return demoAgentId === undefined
    ? undefined
    : and(
        isNotNull(purchases.liveStore),
        eq(purchases.state, "DENIED"),
        eq(mandates.operatorAgentId, demoAgentId),
        like(user.email, "%@example.test"),
      );
}

/** Why a DENY was given: the failed mandate fields, or leg A's PayPal reason. */
function denyReasons(trace: unknown): string[] {
  const fields = failedFields(trace);
  if (fields.length > 0) return fields;
  const errors = (trace as { errors?: unknown[] } | null)?.errors;
  return Array.isArray(errors) ? errors.filter((e): e is string => typeof e === "string") : [];
}

const liveRoute = createRoute({
  method: "get",
  path: "/v1/live-purchases",
  operationId: "listLivePurchases",
  tags: ["purchases"],
  summary: "Live purchases",
  description:
    "Purchases the shopping agent made with real money at real stores' own checkouts, and the carts Keelson denied there before the payment for Keelson's own test users, newest first. Each has a public Alibi; a paid one names the PayPal transaction it paid. Keelson countersigned and logged them; it covers none of them.",
  responses: {
    200: {
      description: "The live purchases",
      content: {
        "application/json": { schema: z.object({ purchases: z.array(LivePurchase) }) },
      },
    },
  },
});

export function registerPurchases(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "demoAgentId" | "cards">,
): void {
  app.openapi(liveRoute, async (c) => {
    const rows = await deps.db
      .select({ purchase: purchases })
      .from(purchases)
      .innerJoin(alibis, eq(alibis.purchaseId, purchases.id))
      .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
      .innerJoin(user, eq(user.id, mandates.userId))
      .where(
        and(
          or(
            and(
              isNotNull(purchases.liveStore),
              or(isNotNull(purchases.paypalTransactionId), publicDenial(deps.demoAgentId)),
            ),
            publicCard(deps.demoAgentId),
          ),
        ),
      )
      .orderBy(desc(purchases.createdAt))
      .limit(100);
    const parts = await breakdowns(
      deps.db,
      rows.map(({ purchase: p }) => p.evidenceRoot),
    );
    const cards = new Map(
      await Promise.all(
        rows
          .filter(({ purchase: p }) => p.rail === "card")
          .map(async ({ purchase: p }) => [p.id, await cardViewOf(deps.db, p.id)] as const),
      ),
    );
    c.header("Cache-Control", "public, max-age=60");
    return c.json(
      {
        purchases: rows.map(({ purchase: p }) => {
          const card = cards.get(p.id);
          const paid = card?.authorizations.find((a) => a.approved);
          return {
            ...withBreakdown(
              { amount: { currency: p.currency, minor: p.amountMinor.toString() } },
              p.evidenceRoot,
              parts,
            ),
            id: p.id,
            store: p.liveStore,
            merchant: p.merchantId,
            decision: p.state === "DENIED" ? ("deny" as const) : ("allow" as const),
            transactionId: p.paypalTransactionId,
            blocked: p.state === "DENIED" ? denyReasons(p.evalTrace) : [],
            ...(card
              ? {
                  card: {
                    lastFour: card.lastFour,
                    merchantName:
                      paid?.merchantName ?? card.authorizations[0]?.merchantName ?? null,
                    mcc: paid?.mcc ?? null,
                    approved: card.authorizations.filter((a) => a.approved).length,
                    declined: card.authorizations.filter((a) => !a.approved).length,
                    settledMinor: card.settledMinor,
                  },
                }
              : {}),
            logIndex: String(p.logIndex),
            createdAt: p.createdAt.toISOString(),
          };
        }),
      },
      200,
    );
  });

  app.openapi(transactionRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { transactionId } = c.req.valid("json");
    const [row] = await deps.db.select().from(purchases).where(eq(purchases.id, id));
    if (!row || row.clientId !== c.var.principal?.subject) {
      return problem(c, 404, "not-found", "Not found");
    }
    if (row.liveStore === null) {
      return problem(c, 409, "not-live", "Not live", "Keelson captures this purchase itself.");
    }
    if (row.state !== "LOGGED") {
      return problem(
        c,
        409,
        "alibi-not-issued",
        "Alibi not issued",
        "The purchase is not logged with its Alibi yet.",
      );
    }
    const taken = () =>
      problem(
        c,
        409,
        "transaction-recorded",
        "Transaction recorded",
        "Another PayPal transaction id is recorded for this purchase, or this one for another.",
      );
    const set = await deps.db
      .update(purchases)
      .set({ paypalTransactionId: transactionId })
      .where(and(eq(purchases.id, id), isNull(purchases.paypalTransactionId)))
      .returning()
      .then(([r]) => r)
      .catch((err: unknown) => {
        const e = err as { code?: string; cause?: { code?: string } };
        if ((e.cause?.code ?? e.code) === "23505") return null;
        throw err;
      });
    if (set === null) return taken();
    const now = set ?? row;
    if (!set && row.paypalTransactionId !== transactionId) return taken();
    c.header("Cache-Control", "no-store");
    return c.json(purchaseView(now), 200);
  });

  app.openapi(route, async (c) => {
    const principal = c.var.principal;
    const [row] = await deps.db
      .select({ purchase: purchases, userId: mandates.userId })
      .from(purchases)
      .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
      .where(eq(purchases.id, c.req.valid("param").id));
    // An app acting for a user reads only the purchases it asked for, for that user.
    const mine =
      row !== undefined &&
      principal !== undefined &&
      (principal.kind === "user"
        ? principal.subject === row.userId
        : principal.subject === row.purchase.clientId &&
          (principal.user === undefined || principal.user === row.userId));
    if (!row || !mine) return problem(c, 404, "not-found", "Not found");
    const p = row.purchase;
    const parts = await breakdowns(deps.db, [p.evidenceRoot]);
    const card = p.rail === "card" ? await cardViewOf(deps.db, p.id) : undefined;
    c.header("Cache-Control", "no-store");
    return c.json(
      withBreakdown({ ...purchaseView(p), ...(card ? { card } : {}) }, p.evidenceRoot, parts),
      200,
    );
  });

  // The card goes to the agent's browser, never to the agent: the issuer's hosted page shows it
  // there, for a minute, and Keelson never reads its number.
  app.openapi(cardRoute, async (c) => {
    const id = c.req.valid("param").id;
    const [row] = await deps.db
      .select({ purchase: purchases, card: purchaseCards })
      .from(purchases)
      .innerJoin(purchaseCards, eq(purchaseCards.purchaseId, purchases.id))
      .where(eq(purchases.id, id));
    if (!row || row.purchase.clientId !== c.var.principal?.subject) {
      return problem(c, 404, "not-found", "Not found");
    }
    const usable =
      row.card.state === "OPEN" &&
      row.purchase.state === "COVERED" &&
      row.card.expiresAt.getTime() > Date.now();
    if (!usable || !deps.cards) {
      return problem(
        c,
        409,
        "card-not-open",
        "Card not open",
        "The card opens once the purchase is logged and covered, and closes after its one use or when its countersign expires.",
      );
    }
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        lastFour: row.card.lastFour,
        expiresAt: row.card.expiresAt.toISOString(),
        embedUrl: deps.cards.issuer.embedUrl(row.card.cardToken, CARD_EMBED_TTL_SEC),
      },
      200,
    );
  });
}

/** How long the card's hosted page link works. */
const CARD_EMBED_TTL_SEC = 60;

const cardRoute = createRoute({
  method: "get",
  path: "/v1/purchases/{id}/card",
  operationId: "getPurchaseCard",
  tags: ["purchases"],
  summary: "The single-use card of a card purchase",
  description:
    "For the agent's browser: a one-minute link to the card issuer's hosted page showing the card's number, expiry and code. Open it in the browser session that pays; never put its contents in a model's context or a log. Only the client that asked for the countersign reads it, and only while the card is open.",
  middleware: [requireClient(["countersign:write"])],
  request: { params: z.object({ id: Id }) },
  responses: {
    200: {
      description: "The card's hosted page",
      content: {
        "application/json": {
          schema: z
            .object({ lastFour: z.string(), expiresAt: z.string(), embedUrl: z.string() })
            .openapi("PurchaseCard"),
        },
      },
    },
    404: { description: "No such card purchase of this client", content: problemContent },
    409: { description: "The card is not open", content: problemContent },
  },
});
