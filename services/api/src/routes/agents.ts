import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  agentConnections,
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  mandates,
  operators,
  purchases,
  sql,
} from "@keelson/db";
import type { Deps } from "../app.ts";
import { publishEvent } from "../events.ts";
import { MERCHANTS } from "../merchants.ts";
import { requireSession } from "../middleware/auth.ts";
import { type Principal, principalChannel } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { stopAgents, userStops } from "../stop.ts";
import { REVOCABLE, revokeMandate } from "./revoke.ts";

const problemContent = { "application/problem+json": { schema: ProblemSchema } };
const AgentId = z.object({ agentId: z.string().regex(/^(0|[1-9]\d{0,77})$/) });

const AgentRow = z
  .object({
    agentId: z.string(),
    name: z.string(),
    operator: z.string(),
    connected: z.boolean(),
    mandate: z
      .object({
        id: z.string(),
        state: z.string(),
        currency: z.string(),
        maxMinor: z.string(),
        remainingMinor: z.string(),
        expiresAt: z.string(),
        merchants: z.array(z.string()),
      })
      .nullable()
      .openapi({ description: "The live mandate the agent buys under, if any." }),
    lastActivityAt: z.string(),
  })
  .openapi("Agent");

const Pending = z
  .object({
    code: z.string(),
    name: z.string(),
    currency: z.string(),
    amountMinor: z.string(),
    overMinor: z.string().nullable().openapi({
      description: "How far above the mandate the cart is; null when it is the store.",
    }),
    merchant: z.string(),
    mandateId: z.string(),
    expiresAt: z.string(),
  })
  .openapi("PendingApproval");

const Revoked = z
  .object({ revoked: z.int().openapi({ description: "Mandates stopped." }) })
  .openapi("AgentsRevoked");

const list = createRoute({
  method: "get",
  path: "/v1/agents",
  tags: ["agents"],
  summary: "List your agents",
  description:
    "Each agent that holds or held a mandate of yours, or that you connected: its live mandate with what is left, and when it last acted.",
  middleware: [requireSession()],
  responses: {
    200: {
      description: "The agents, most recently active first",
      content: { "application/json": { schema: z.object({ agents: z.array(AgentRow) }) } },
    },
    401: { description: "Not signed in", content: problemContent },
  },
});

const approvals = createRoute({
  method: "get",
  path: "/v1/approvals",
  tags: ["agents"],
  summary: "Carts paused for your approval",
  description:
    "Carts your agents tried that their mandate does not allow, each waiting for you to approve it once or decline it. New ones arrive as `approval.requested` events on the `agents` channel.",
  middleware: [requireSession()],
  responses: {
    200: {
      description: "The open requests, newest first",
      content: { "application/json": { schema: z.object({ approvals: z.array(Pending) }) } },
    },
    401: { description: "Not signed in", content: problemContent },
  },
});

const disconnect = createRoute({
  method: "post",
  path: "/v1/agents/{agentId}/disconnect",
  tags: ["agents"],
  summary: "Disconnect an agent",
  description:
    "Revokes every live mandate of yours that names the agent and ends its connections. Keelson refuses its countersigns from now on; purchases already countersigned may still be captured.",
  middleware: [requireSession()],
  request: {
    params: AgentId,
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
  },
  responses: {
    200: { description: "Disconnected", content: { "application/json": { schema: Revoked } } },
    401: { description: "Not signed in", content: problemContent },
    404: { description: "No agent of yours with this id", content: problemContent },
  },
});

const StopSchema = z
  .object({
    id: z.string(),
    revoked: z.int().openapi({ description: "Mandates ended." }),
    released: z
      .array(z.object({ currency: z.string(), minor: z.string() }))
      .openapi({ description: "What PayPal held for them, per currency, now released." }),
    mandateHashes: z.array(z.string()).openapi({
      description:
        "Hex of the stopped mandates' hashes. The stop leaf commits to their digest: no Alibi leaf after it may carry one.",
    }),
    releasing: z.array(z.object({ currency: z.string(), minor: z.string() })).openapi({
      description:
        "Holds backing purchases already countersigned: released once those are captured.",
    }),
    logIndexes: z.record(z.string(), z.string()).openapi({
      description:
        "The stop leaf's index in each Alibi log origin. It is appended once no purchase of the stopped mandates can still be logged, so no Alibi leaf after it carries one of their hashes.",
    }),
    logged: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("AgentStop");

const stopRoute = createRoute({
  method: "post",
  path: "/v1/agents/stop",
  tags: ["agents"],
  summary: "Stop all agents",
  description:
    "The kill switch. Keelson refuses every countersign of a mandate of yours stored before now, revokes every live mandate and voids its PayPal holds, denies every open request, revokes every agent's OAuth grant, and logs the stop as a `keelson.finance/stop/v1` leaf in the Alibi log. Purchases already countersigned may still be captured.",
  middleware: [requireSession()],
  request: { headers: z.object({ "idempotency-key": z.string().min(1).max(255) }) },
  responses: {
    200: { description: "Stopped", content: { "application/json": { schema: StopSchema } } },
    401: { description: "Not signed in", content: problemContent },
  },
});

const stops = createRoute({
  method: "get",
  path: "/v1/agents/stops",
  tags: ["agents"],
  summary: "Your stops",
  description: "Each time you stopped all agents, newest first, with its log index.",
  middleware: [requireSession()],
  responses: {
    200: {
      description: "The stops",
      content: { "application/json": { schema: z.object({ stops: z.array(StopSchema) }) } },
    },
    401: { description: "Not signed in", content: problemContent },
  },
});

const LIVE = [...REVOCABLE];

export function registerAgents(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "log" | "paypal" | "tlog">,
): void {
  const { db } = deps;

  /** Stops the user's live mandates (of one agent, or all) and ends the matching connections. */
  async function stop(userId: string, agentId?: bigint): Promise<number> {
    // Every countersign stops at once; the holds are released one by one after. A second pass
    // catches a mandate stored while the first one ran.
    const flag = () =>
      db
        .update(mandates)
        .set({ revokeRequestedAt: sql`coalesce(${mandates.revokeRequestedAt}, now())` })
        .where(
          and(
            eq(mandates.userId, userId),
            inArray(mandates.state, LIVE),
            agentId === undefined ? undefined : eq(mandates.operatorAgentId, agentId),
          ),
        )
        .returning();
    const first = await flag();
    const later = (await flag()).filter((r) => !first.some((f) => f.id === r.id));
    const rows = [...first, ...later];
    for (const row of rows) {
      try {
        await revokeMandate(deps, row);
      } catch (err) {
        // The sweeper voids a hold whose revoke is requested; countersigns are already refused.
        deps.log.warn({ err, mandateId: row.id }, "hold not voided on revoke; the sweeper retries");
      }
    }
    await db
      .update(agentConnections)
      .set({ disconnectedAt: new Date() })
      .where(
        and(
          eq(agentConnections.userId, userId),
          isNull(agentConnections.disconnectedAt),
          agentId === undefined ? undefined : eq(agentConnections.operatorAgentId, agentId),
        ),
      );
    // Pending one-time approvals for this user would only be refused later; decline them now.
    await db
      .update(agentConnections)
      .set({ state: "DENIED", decidedAt: new Date() })
      .where(
        and(
          eq(agentConnections.userId, userId),
          eq(agentConnections.state, "PENDING"),
          agentId === undefined ? undefined : eq(agentConnections.operatorAgentId, agentId),
        ),
      );
    await publishEvent(
      deps,
      principalChannel({ kind: "user", subject: userId }, "agents"),
      agentId?.toString() ?? "all",
      {
        type: agentId === undefined ? "agents.frozen" : "agent.disconnected",
        revoked: rows.length,
      },
    );
    return rows.length;
  }

  app.openapi(list, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    const owned = await db
      .select({ mandate: mandates, operator: operators })
      .from(mandates)
      .innerJoin(operators, eq(operators.agentId, mandates.operatorAgentId))
      .where(eq(mandates.userId, userId))
      .orderBy(desc(mandates.createdAt));
    const connected = await db
      .select({ connection: agentConnections, operator: operators })
      .from(agentConnections)
      .innerJoin(operators, eq(operators.agentId, agentConnections.operatorAgentId))
      .where(
        and(
          eq(agentConnections.userId, userId),
          eq(agentConnections.kind, "connect"),
          eq(agentConnections.state, "APPROVED"),
        ),
      )
      .orderBy(desc(agentConnections.decidedAt));
    const bought = owned.length
      ? await db
          .select({ mandateId: purchases.mandateId, at: sql<Date>`max(${purchases.createdAt})` })
          .from(purchases)
          .where(
            inArray(
              purchases.mandateId,
              owned.map((o) => o.mandate.id),
            ),
          )
          .groupBy(purchases.mandateId)
      : [];
    const lastBuy = new Map(bought.map((b) => [b.mandateId, new Date(b.at)]));

    const agents = new Map<string, z.infer<typeof AgentRow> & { at: number }>();
    const touch = (
      operator: typeof operators.$inferSelect,
      at: Date,
      name?: string,
      live?: boolean,
    ) => {
      const id = operator.agentId.toString();
      const row = agents.get(id) ?? {
        agentId: id,
        name: name ?? operator.name,
        operator: operator.name,
        connected: false,
        mandate: null,
        lastActivityAt: at.toISOString(),
        at: at.getTime(),
      };
      if (name && row.name === operator.name) row.name = name;
      if (live) row.connected = true;
      if (at.getTime() > row.at) {
        row.at = at.getTime();
        row.lastActivityAt = at.toISOString();
      }
      agents.set(id, row);
      return row;
    };
    for (const { connection, operator } of connected) {
      touch(
        operator,
        connection.decidedAt ?? connection.createdAt,
        connection.name,
        !connection.disconnectedAt,
      );
    }
    for (const { mandate, operator } of owned) {
      const live =
        LIVE.includes(mandate.state as (typeof LIVE)[number]) &&
        !mandate.revokeRequestedAt &&
        mandate.expiresAt > new Date();
      const row = touch(operator, lastBuy.get(mandate.id) ?? mandate.createdAt, undefined, live);
      if (
        live &&
        (!row.mandate || (row.mandate.state !== "ACTIVE" && mandate.state === "ACTIVE"))
      ) {
        row.mandate = {
          id: mandate.id,
          state: mandate.state,
          currency: mandate.currency,
          maxMinor: mandate.maxMinor.toString(),
          remainingMinor: mandate.remainingMinor.toString(),
          expiresAt: mandate.expiresAt.toISOString(),
          merchants: mandate.merchantIds.map(
            (id) => MERCHANTS.find((m) => m.id === id)?.name ?? id,
          ),
        };
      }
    }
    const sorted = [...agents.values()].sort((a, b) => b.at - a.at).map(({ at: _, ...row }) => row);
    return c.json({ agents: sorted }, 200);
  });

  app.openapi(approvals, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    const rows = await db
      .select({ request: agentConnections, parent: mandates })
      .from(agentConnections)
      .innerJoin(mandates, eq(mandates.id, agentConnections.parentMandateId))
      .where(
        and(
          eq(agentConnections.userId, userId),
          eq(agentConnections.kind, "once"),
          eq(agentConnections.state, "PENDING"),
          gt(agentConnections.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(agentConnections.createdAt));
    return c.json(
      {
        approvals: rows.map(({ request, parent }) => {
          const merchant = request.merchantIds[0] ?? "";
          const inStores = parent.merchantIds.includes(merchant);
          const over = request.perPurchaseMinor - parent.remainingMinor;
          return {
            code: request.userCode,
            name: request.name,
            currency: request.currency,
            amountMinor: request.perPurchaseMinor.toString(),
            overMinor: inStores && over > 0n ? over.toString() : null,
            merchant: MERCHANTS.find((m) => m.id === merchant)?.name ?? merchant,
            mandateId: parent.id,
            expiresAt: request.expiresAt.toISOString(),
          };
        }),
      },
      200,
    );
  });

  app.openapi(stopRoute, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    return c.json(await stopAgents(deps, userId), 200);
  });

  app.openapi(stops, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    return c.json({ stops: await userStops(db, userId) }, 200);
  });

  app.openapi(disconnect, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    const agentId = BigInt(c.req.valid("param").agentId);
    const [mine] = await db
      .select({ id: sql<number>`1` })
      .from(mandates)
      .where(and(eq(mandates.userId, userId), eq(mandates.operatorAgentId, agentId)))
      .limit(1);
    const [linked] = mine
      ? [mine]
      : await db
          .select({ id: sql<number>`1` })
          .from(agentConnections)
          .where(
            and(eq(agentConnections.userId, userId), eq(agentConnections.operatorAgentId, agentId)),
          )
          .limit(1);
    if (!linked) return problem(c, 404, "not-found", "Not found");
    return c.json({ revoked: await stop(userId, agentId) }, 200);
  });
}
