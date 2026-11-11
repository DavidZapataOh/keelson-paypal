import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { agentConnections, and, createQueries, eq, mandates, sql, transition } from "@keelson/db";
import type { Deps } from "../app.ts";
import { voidHold } from "../hold/maintenance.ts";
import { publishHold } from "../hold/state.ts";
import { requireSession } from "../middleware/auth.ts";
import { paypalProblem } from "../paypal.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { publishStatusList } from "../status-list.ts";

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

type RevokeDeps = Pick<Deps, "db" | "kv" | "log" | "paypal"> & { tee?: Deps["tee"] };

/** The mandate states a revoke can still end. */
export const REVOCABLE = ["SIGNED", "HOLD_PENDING", "ACTIVE"] as const;

/**
 * Stops new countersigns for the mandate at once, then releases what it holds: a signed mandate
 * is revoked now, a held one voided at PayPal (by the sweeper, while a countersigned purchase may
 * still be captured). Throws PayPal's error when it refuses the void; countersigns stay stopped.
 */
export async function revokeMandate(
  deps: RevokeDeps,
  row: typeof mandates.$inferSelect,
): Promise<"REVOKED" | "REVOKING"> {
  const { db } = deps;
  await db
    .update(mandates)
    .set({ revokeRequestedAt: sql`coalesce(${mandates.revokeRequestedAt}, now())` })
    .where(eq(mandates.id, row.id));
  // The public status list says so too; the next countersign signs it again if this fails.
  if (deps.tee && row.statusIdx !== null) {
    await publishStatusList({ db, log: deps.log, tee: deps.tee }).catch((err: unknown) =>
      deps.log.warn({ err, mandateId: row.id }, "status list not signed after a revoke"),
    );
  }
  // Carts paused under it can no longer be approved.
  await db
    .update(agentConnections)
    .set({ state: "DENIED", decidedAt: new Date() })
    .where(
      and(eq(agentConnections.parentMandateId, row.id), eq(agentConnections.state, "PENDING")),
    );
  if (row.state === "SIGNED") {
    if (await transition(db, "mandates", row.id, "SIGNED", "REVOKED")) {
      await publishHold(deps, row, { state: "REVOKED" });
    }
  } else if (deps.paypal) {
    await voidHold({ ...deps, paypal: deps.paypal }, row.id, "REVOKED");
  }
  const [now] = await db
    .select({ state: mandates.state })
    .from(mandates)
    .where(eq(mandates.id, row.id));
  return now?.state === "REVOKED" ? "REVOKED" : "REVOKING";
}

export function registerRevoke(app: OpenAPIHono, deps: RevokeDeps): void {
  const queries = createQueries(deps.db);

  app.openapi(route, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    const id = c.req.valid("param").id;
    const row = await queries.mandateById(id);
    if (!row || row.userId !== userId) return problem(c, 404, "not-found", "Not found");
    if (row.state === "REVOKED") return c.json({ state: "REVOKED" as const }, 200);
    if (!(REVOCABLE as readonly string[]).includes(row.state)) {
      return problem(c, 409, "mandate-ended", "Mandate ended", `The mandate is ${row.state}.`);
    }
    let state: "REVOKED" | "REVOKING";
    try {
      state = await revokeMandate(deps, row);
    } catch (err) {
      const answer = paypalProblem(c, err);
      if (answer) return answer;
      throw err;
    }
    return state === "REVOKED"
      ? c.json({ state: "REVOKED" as const }, 200)
      : c.json({ state: "REVOKING" as const }, 202);
  });
}
