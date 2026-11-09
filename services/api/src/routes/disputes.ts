import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { disputes, eq, paypalEvents, sql, verdicts } from "@keelson/db";
import type { Context } from "hono";
import type { Deps } from "../app.ts";
import { ProblemSchema, problem } from "../problem.ts";

const PARTIES = ["operator", "keelson", "merchant", "user"] as const;

const Party = z.enum(PARTIES);

const DisputeStatus = z
  .object({
    dispute_id: z.string(),
    purchase_id: z.string(),
    state: z.enum(["OPEN", "ATTRIBUTED", "RESOLVED"]),
    reason: z.string().openapi({ description: "PayPal's `dispute_reason`." }),
    received_at: z.iso.datetime().nullable().openapi({
      description: "When Keelson received the dispute's first webhook or poll.",
    }),
    attributed_at: z.iso.datetime().nullable(),
    elapsed_ms: z.number().int().nullable().openapi({
      description: "From `received_at` to `attributed_at`; null while the dispute is open.",
    }),
    liable: Party.nullable(),
    parties: z.array(z.object({ party: Party.exclude(["user"]), liable: z.boolean() })).openapi({
      description:
        "The parties a verdict can make pay: the operator's bond, Keelson's reserve, or the merchant through PayPal.",
    }),
    verdict: z
      .object({
        rule: z.string().openapi({ example: "R61" }),
        digest: z.string(),
        chain_id: z.number().int(),
        message: z.record(z.string(), z.string()),
        signatures: z.array(
          z.object({ tee: z.number().int(), signer: z.string(), signature: z.string() }),
        ),
        facts: z.record(z.string(), z.union([z.string(), z.boolean()])),
      })
      .nullable(),
  })
  .openapi("DisputeStatus");

const route = createRoute({
  method: "get",
  path: "/v1/disputes/{id}",
  tags: ["Disputes"],
  summary: "A dispute's attribution",
  description:
    "Where a PayPal dispute over a Keelson purchase stands: the party at fault, the `Verdict` both TEE legs signed and the time from the dispute's arrival to its verdict. No authentication; it holds no personal data.",
  request: { params: z.object({ id: z.string().regex(/^PP-D-[0-9A-Za-z-]{1,40}$/) }) },
  responses: {
    200: { description: "The dispute", content: { "application/json": { schema: DisputeStatus } } },
    404: {
      description: "No dispute with this id over a Keelson purchase",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export function registerDisputes(app: OpenAPIHono, deps: Pick<Deps, "db">): void {
  app.openapi(route, (async (c: Context) => {
    const { id } = c.req.param() as { id: string };
    const [row] = await deps.db
      .select({
        id: disputes.id,
        purchaseId: disputes.purchaseId,
        state: disputes.state,
        reason: disputes.reason,
        receivedAt: sql<Date | null>`(select min(${paypalEvents.receivedAt}) from ${paypalEvents} where ${paypalEvents.disputeId} = ${disputes.id})`,
        verdict: verdicts,
      })
      .from(disputes)
      .leftJoin(verdicts, eq(verdicts.disputeId, disputes.id))
      .where(eq(disputes.id, id));
    if (!row) return problem(c, 404, "not-found", "Not found", "No such dispute.");
    const v = row.verdict;
    const received = row.receivedAt ? new Date(row.receivedAt) : null;
    const liable = v ? (PARTIES[v.liable - 1] ?? null) : null;
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        dispute_id: row.id,
        purchase_id: row.purchaseId,
        state: row.state,
        reason: row.reason,
        received_at: received?.toISOString() ?? null,
        attributed_at: v?.createdAt.toISOString() ?? null,
        elapsed_ms: v && received ? v.createdAt.getTime() - received.getTime() : null,
        liable,
        parties: (["operator", "keelson", "merchant"] as const).map((party) => ({
          party,
          liable: liable === party,
        })),
        verdict: v
          ? {
              rule: `R${String(v.ruleId).padStart(2, "0")}`,
              digest: `0x${Buffer.from(v.digest).toString("hex")}`,
              chain_id: v.chainId,
              message: v.message,
              signatures: v.signatures,
              facts: v.facts as Record<string, string | boolean>,
            }
          : null,
      },
      200,
    );
  }) as never);
}
