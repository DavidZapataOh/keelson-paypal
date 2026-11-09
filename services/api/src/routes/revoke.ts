import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { createQueries, eq, mandates, sql, transition } from "@keelson/db";
import type { Deps } from "../app.ts";
import { voidHold } from "../hold/maintenance.ts";
import { publishHold } from "../hold/state.ts";
import { requireSession } from "../middleware/auth.ts";
import { paypalProblem } from "../paypal.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

const Revoked = z.object({ state: z.literal("REVOKED") }).openapi("RevokedMandate");
const Revoking = z.object({ state: z.literal("REVOKING") }).openapi("RevokingMandate", {
  description:
    "Purchases already countersigned may still be captured; the hold is voided after them.",
});

const route = createRoute({
  method: "post",
  path: "/v1/mandates/{id}/revoke",
  tags: ["mandates"],
  summary: "Revoke a mandate",
  description:
    "Stops new countersigns at once, voids the PayPal hold and moves the mandate to `REVOKED`. While a countersigned purchase may still be captured, the void waits for it and the revocation completes in the background.",
  middleware: [requireSession()],
  request: {
    params: z.object({ id: z.string() }),
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
  },
  responses: {
    200: {
      description: "The mandate is revoked",
      content: { "application/json": { schema: Revoked } },
    },
    202: {
      description: "The mandate is being revoked",
      content: { "application/json": { schema: Revoking } },
    },
    401: { description: "Not signed in", content: problemContent },
    404: { description: "No such mandate for this user", content: problemContent },
    409: { description: "The mandate has already ended", content: problemContent },
    422: { description: "PayPal refused the void", content: problemContent },
    503: { description: "PayPal is unavailable", content: problemContent },
  },
});

export function registerRevoke(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "log" | "paypal">,
): void {
  const { db } = deps;
  const queries = createQueries(db);

  app.openapi(route, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    const id = c.req.valid("param").id;
    const row = await queries.mandateById(id);
    if (!row || row.userId !== userId) return problem(c, 404, "not-found", "Not found");
    const revoked = () => c.json({ state: "REVOKED" as const }, 200);
    if (row.state === "REVOKED") return revoked();
    if (row.state !== "SIGNED" && row.state !== "HOLD_PENDING" && row.state !== "ACTIVE") {
      return problem(c, 409, "mandate-ended", "Mandate ended", `The mandate is ${row.state}.`);
    }

    await db
      .update(mandates)
      .set({ revokeRequestedAt: sql`coalesce(${mandates.revokeRequestedAt}, now())` })
      .where(eq(mandates.id, id));
    if (row.state === "SIGNED") {
      if (await transition(db, "mandates", id, "SIGNED", "REVOKED")) {
        await publishHold(deps, row, { state: "REVOKED" });
      }
    } else if (deps.paypal) {
      try {
        await voidHold({ ...deps, paypal: deps.paypal }, id, "REVOKED");
      } catch (err) {
        const answer = paypalProblem(c, err);
        if (answer) return answer;
        throw err;
      }
    }
    const now = await queries.mandateById(id);
    return now?.state === "REVOKED" ? revoked() : c.json({ state: "REVOKING" as const }, 202);
  });
}
