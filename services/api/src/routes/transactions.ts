import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Deps } from "../app.ts";
import { TxRecordSchema, txJson } from "../onchain/respond.ts";
import { ProblemSchema, problem } from "../problem.ts";

const route = createRoute({
  method: "get",
  path: "/v1/transactions/{id}",
  tags: ["transactions"],
  summary: "A relayed transaction",
  description:
    "A transaction the Keelson relayer sent: its status, hash, receipt fields and explorer link. Final records are immutable.",
  request: { params: z.object({ id: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/) }) },
  responses: {
    200: {
      description: "The transaction",
      headers: z.object({ "Cache-Control": z.string() }),
      content: { "application/json": { schema: TxRecordSchema } },
    },
    404: {
      description: "No such transaction",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export function registerTransactions(app: OpenAPIHono, deps: Pick<Deps, "relayer">): void {
  app.openapi(route, async (c) => {
    const record = await deps.relayer?.getById(c.req.valid("param").id);
    if (!deps.relayer || !record) return problem(c, 404, "not-found", "Not found");
    // A receipt may still be replaced by its canonical copy for two minutes after it arrived.
    const final =
      (record.status === "confirmed" || record.status === "reverted") &&
      record.confirmedAt !== undefined &&
      Date.now() - record.confirmedAt.getTime() > 120_000;
    c.header("Cache-Control", final ? "public, max-age=31536000, immutable" : "no-store");
    return c.json(txJson(deps.relayer, record), 200);
  });
}
