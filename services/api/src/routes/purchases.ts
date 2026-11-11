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
  purchases,
  type SQL,
  user,
} from "@keelson/db";
import type { Deps } from "../app.ts";
import { Amount, breakdowns, withBreakdown } from "../checkout.ts";
import { requireClient, requirePrincipal } from "../middleware/auth.ts";
import { failedFields, type PurchaseView, purchaseView } from "../pipeline/drive.ts";
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
  live: z.object({ store: z.string(), transactionId: z.string().nullable() }).optional().openapi({
    description:
      "A purchase the buyer pays at the store's own checkout: the store's origin and the PayPal transaction id once the agent recorded it. Never covered nor captured.",
  }),
});

export function progressOf(view: PurchaseView | undefined): z.infer<typeof PurchaseProgress> {
  if (!view) return {};
  const { state, logIndex, coverage, capture, failure, blocked, reasons, live } = view;
  return {
    state,
    ...(logIndex ? { logIndex } : {}),
    ...(coverage ? { coverage } : {}),
    ...(capture ? { capture } : {}),
    ...(failure ? { failure } : {}),
    ...(blocked ? { blocked } : {}),
    ...(reasons ? { reasons } : {}),
    ...(live ? { live } : {}),
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
  tags: ["purchases"],
  summary: "A purchase",
  description:
    "The purchase's state: its log index, its coverage and its capture once each is recorded. Readable by the mandate's owner and by the client that asked for the countersign.",
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
    store: z.string(),
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
    logIndex: z.string(),
    createdAt: z.string(),
  })
  .openapi("LivePurchase");

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

export function registerPurchases(app: OpenAPIHono, deps: Pick<Deps, "db" | "demoAgentId">): void {
  app.openapi(liveRoute, async (c) => {
    const rows = await deps.db
      .select({ purchase: purchases })
      .from(purchases)
      .innerJoin(alibis, eq(alibis.purchaseId, purchases.id))
      .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
      .innerJoin(user, eq(user.id, mandates.userId))
      .where(
        and(
          isNotNull(purchases.liveStore),
          or(isNotNull(purchases.paypalTransactionId), publicDenial(deps.demoAgentId)),
        ),
      )
      .orderBy(desc(purchases.createdAt))
      .limit(100);
    const parts = await breakdowns(
      deps.db,
      rows.map(({ purchase: p }) => p.evidenceRoot),
    );
    c.header("Cache-Control", "public, max-age=60");
    return c.json(
      {
        purchases: rows.map(({ purchase: p }) => ({
          ...withBreakdown(
            { amount: { currency: p.currency, minor: p.amountMinor.toString() } },
            p.evidenceRoot,
            parts,
          ),
          id: p.id,
          store: p.liveStore as string,
          merchant: p.merchantId,
          decision: p.state === "DENIED" ? ("deny" as const) : ("allow" as const),
          transactionId: p.paypalTransactionId,
          blocked: p.state === "DENIED" ? denyReasons(p.evalTrace) : [],
          logIndex: String(p.logIndex),
          createdAt: p.createdAt.toISOString(),
        })),
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
    const mine =
      row !== undefined &&
      principal !== undefined &&
      (principal.kind === "user"
        ? principal.subject === row.userId
        : principal.subject === row.purchase.clientId);
    if (!row || !mine) return problem(c, 404, "not-found", "Not found");
    const p = row.purchase;
    const parts = await breakdowns(deps.db, [p.evidenceRoot]);
    c.header("Cache-Control", "no-store");
    return c.json(withBreakdown(purchaseView(p), p.evidenceRoot, parts), 200);
  });
}
