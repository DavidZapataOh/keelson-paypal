import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { eq, mandates, purchases } from "@keelson/db";
import type { Deps } from "../app.ts";
import { requirePrincipal } from "../middleware/auth.ts";
import { type PurchaseView, purchaseView } from "../pipeline/drive.ts";
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
});

export function progressOf(view: PurchaseView | undefined): z.infer<typeof PurchaseProgress> {
  if (!view) return {};
  const { state, logIndex, coverage, capture, failure } = view;
  return {
    state,
    ...(logIndex ? { logIndex } : {}),
    ...(coverage ? { coverage } : {}),
    ...(capture ? { capture } : {}),
    ...(failure ? { failure } : {}),
  };
}

const Purchase = z
  .object({
    id: z.string(),
    mandateId: z.string(),
    mode: z.enum(["2of2", "degraded"]).nullable(),
    amount: z.object({ currency: z.string(), minor: z.string() }),
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

export function registerPurchases(app: OpenAPIHono, deps: Pick<Deps, "db">): void {
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
    c.header("Cache-Control", "no-store");
    return c.json(purchaseView(row.purchase), 200);
  });
}
