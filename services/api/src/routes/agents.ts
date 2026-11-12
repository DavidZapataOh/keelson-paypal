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
  oauthConsent,
  oauthRefreshToken,
  operators,
  purchases,
  sql,
  ssfStreams,
} from "@keelson/db";
import type { Deps } from "../app.ts";
import { publishEvent } from "../events.ts";
import { MERCHANTS } from "../merchants.ts";
import { requireSession } from "../middleware/auth.ts";
import { type Principal, principalChannel } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { emitSessionRevoked } from "../ssf.ts";
import { stopAgents, userStops } from "../stop.ts";
import { REVOCABLE, revokeMandate } from "./revoke.ts";

const problemContent = { "application/problem+json": { schema: ProblemSchema } };
const AgentId = z.object({ agentId: z.string().regex(/^(0|[1-9]\d{0,77})$/) });

const AgentRow = z
  .object({
    agentId: z.string(),
    clientId: z.string().nullable().openapi({
      description:
        "The app acting through Keelson's hosted operator, which many apps share: disconnect it alone with `?client=`. Null for an agent's own operator, and for the hosted operator's mandates no app holds (`Unknown app`).",
    }),
    name: z.string(),
    operator: z.string(),
    connected: z.boolean(),
    signals: z.boolean().openapi({
      description:
        "Whether the app polls a Shared Signals stream (OpenID SSF), so it learns at once when you stop or disconnect it.",
    }),
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
  operationId: "listAgents",
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
  operationId: "listApprovals",
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
  operationId: "disconnectAgent",
  tags: ["agents"],
  summary: "Disconnect an agent",
  description:
    "Revokes every live mandate of yours that names the agent and ends its connections. Keelson refuses its countersigns from now on; purchases already countersigned may still be captured.\n\nWith `client`, only that app, of the apps acting through the agent: the mandates you approved for it, its requests, its OAuth grant and refresh tokens, and the access tokens it holds for you. Apps acting through Keelson's hosted operator are disconnected this way; without `client`, the hosted operator ends only your mandates of it that no app holds (its `Unknown app` row).",
  middleware: [requireSession()],
  request: {
    params: AgentId,
    query: z.object({ client: z.string().min(1).max(255).optional() }),
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
    statusListed: z.int().optional().openapi({
      description:
        "On the stop's own answer: how many of the stopped mandates the public status list (`GET /status/v1/mandates/2026-1`) now marks revoked.",
    }),
  })
  .openapi("AgentStop");

const stopRoute = createRoute({
  method: "post",
  path: "/v1/agents/stop",
  operationId: "stopAgents",
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
  operationId: "listAgentStops",
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
  deps: Pick<
    Deps,
    | "db"
    | "kv"
    | "log"
    | "paypal"
    | "tlog"
    | "notifier"
    | "demoAgentId"
    | "tee"
    | "auth"
    | "authBaseUrl"
  >,
): void {
  const { db } = deps;

  /** The user's mandates of the hosted operator that no app was approved for. */
  const orphan = sql`not exists (select 1 from ${agentConnections} where ${agentConnections.mandateId} = ${mandates.id} and ${agentConnections.state} = 'APPROVED')`;

  /**
   * Stops the user's live mandates (of one agent, or all) and ends the matching connections; with
   * `clientId`, only those of that app acting through the agent, whose OAuth grant ends too. With
   * `orphans`, only the agent's mandates no app was approved for, and no app's connection.
   */
  async function stop(
    userId: string,
    agentId?: bigint,
    clientId?: string,
    orphans = false,
  ): Promise<number> {
    const ofApp = orphans
      ? orphan
      : clientId === undefined
        ? undefined
        : sql`exists (select 1 from ${agentConnections} where ${agentConnections.mandateId} = ${mandates.id} and ${agentConnections.state} = 'APPROVED' and ${agentConnections.clientId} = ${clientId})`;
    const app = orphans
      ? sql`false`
      : clientId === undefined
        ? undefined
        : eq(agentConnections.clientId, clientId);
    // An app's grant ends before its connections do: an access token refreshed until then was
    // issued before they ended, which refuses it by its issue time (see stopped.ts).
    if (clientId !== undefined) {
      await db
        .update(oauthRefreshToken)
        .set({ revoked: new Date() })
        .where(
          and(
            eq(oauthRefreshToken.userId, userId),
            eq(oauthRefreshToken.clientId, clientId),
            isNull(oauthRefreshToken.revoked),
          ),
        );
      await db
        .delete(oauthConsent)
        .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)));
      await emitSessionRevoked(
        { db, auth: deps.auth, ssfIssuer: deps.authBaseUrl ?? "https://api.keelson.finance" },
        { userId, clientId, at: new Date(), reason: "The user disconnected this app." },
      ).catch((err: unknown) => deps.log.warn({ err, clientId }, "disconnect signal not queued"));
    }
    await db
      .update(agentConnections)
      .set({ disconnectedAt: new Date() })
      .where(
        and(
          eq(agentConnections.userId, userId),
          isNull(agentConnections.disconnectedAt),
          agentId === undefined ? undefined : eq(agentConnections.operatorAgentId, agentId),
          app,
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
          app,
        ),
      );
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
            ofApp,
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
    await publishEvent(
      deps,
      principalChannel({ kind: "user", subject: userId }, "agents"),
      agentId?.toString() ?? "all",
      {
        type: agentId === undefined ? "agents.frozen" : "agent.disconnected",
        revoked: rows.length,
        ...(clientId === undefined ? {} : { clientId }),
      },
    );
    return rows.length;
  }

  app.openapi(list, async (c) => {
    const userId = (c.get("principal") as Principal).subject;
    const owned = await db
      .select({
        mandate: mandates,
        operator: operators,
        clientId: sql<
          string | null
        >`(select ${agentConnections.clientId} from ${agentConnections} where ${agentConnections.mandateId} = ${mandates.id} and ${agentConnections.state} = 'APPROVED' limit 1)`,
      })
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

    const streaming = new Set(
      (
        await db
          .select({ clientId: ssfStreams.clientId })
          .from(ssfStreams)
          .where(and(eq(ssfStreams.userId, userId), eq(ssfStreams.status, "enabled")))
      ).map((s) => s.clientId),
    );
    const agents = new Map<string, z.infer<typeof AgentRow> & { at: number }>();
    // Apps acting through the hosted operator share it: each is its own row.
    const touch = (
      operator: typeof operators.$inferSelect,
      at: Date,
      clientId: string | null,
      name?: string,
      live?: boolean,
    ) => {
      const id = operator.agentId.toString();
      const app = operator.agentId === deps.demoAgentId ? clientId : null;
      const key = app === null ? id : `${id}:${app}`;
      const row = agents.get(key) ?? {
        agentId: id,
        clientId: app,
        name:
          name ??
          (operator.agentId === deps.demoAgentId && clientId === null
            ? "Unknown app"
            : operator.name),
        operator: operator.name,
        connected: false,
        signals: app !== null && streaming.has(app),
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
      agents.set(key, row);
      return row;
    };
    for (const { connection, operator } of connected) {
      touch(
        operator,
        connection.decidedAt ?? connection.createdAt,
        connection.clientId,
        connection.name,
        !connection.disconnectedAt,
      );
    }
    for (const { mandate, operator, clientId } of owned) {
      const live =
        LIVE.includes(mandate.state as (typeof LIVE)[number]) &&
        !mandate.revokeRequestedAt &&
        mandate.expiresAt > new Date();
      const row = touch(
        operator,
        lastBuy.get(mandate.id) ?? mandate.createdAt,
        clientId,
        undefined,
        live,
      );
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
    const { client } = c.req.valid("query");
    // The hosted operator acts for many apps: without one named, only what no app holds ends.
    const orphans = client === undefined && agentId === deps.demoAgentId;
    const [mine] =
      client === undefined
        ? await db
            .select({ id: sql<number>`1` })
            .from(mandates)
            .where(
              and(
                eq(mandates.userId, userId),
                eq(mandates.operatorAgentId, agentId),
                orphans ? orphan : undefined,
              ),
            )
            .limit(1)
        : [];
    const [linked] =
      mine || orphans
        ? [mine]
        : await db
            .select({ id: sql<number>`1` })
            .from(agentConnections)
            .where(
              and(
                eq(agentConnections.userId, userId),
                eq(agentConnections.operatorAgentId, agentId),
                client === undefined ? undefined : eq(agentConnections.clientId, client),
              ),
            )
            .limit(1);
    if (!linked) return problem(c, 404, "not-found", "Not found");
    return c.json({ revoked: await stop(userId, agentId, client, orphans) }, 200);
  });
}
