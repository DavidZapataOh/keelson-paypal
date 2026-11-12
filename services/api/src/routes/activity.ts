import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { agentStops, desc, events, inArray, mandates, or, purchases, sql } from "@keelson/db";
import type { Deps } from "../app.ts";
import { agentName } from "../connections.ts";
import { MERCHANTS } from "../merchants.ts";
import { requireSession } from "../middleware/auth.ts";
import { money } from "../notify/notifier.ts";
import { type Principal, principalChannel } from "../principal.ts";
import { ProblemSchema } from "../problem.ts";

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

/** How many of the user's latest events the feed reads. */
const WINDOW = 200;

const Row = z
  .object({
    id: z.string(),
    at: z.string(),
    tone: z.enum(["good", "warn", "bad"]),
    line: z.string().openapi({ example: "Claude Code bought $94.00 at RunFast." }),
    agentId: z.string().nullable(),
    purchaseId: z.string().nullable(),
    mandateId: z.string().nullable(),
    /** Where the row opens in the app. */
    href: z.string().nullable(),
    alibiUrl: z.string().nullable(),
    logIndex: z.string().nullable(),
  })
  .openapi("ActivityRow");

const list = createRoute({
  method: "get",
  path: "/v1/activity",
  operationId: "listActivity",
  tags: ["agents"],
  summary: "Read your activity",
  description:
    "What your agents and Keelson did, newest first, one plain line each: requests, purchases, blocks and stops. Purchases link to their Alibi and log entry.",
  middleware: [requireSession()],
  request: {
    query: z.object({
      agent: z
        .string()
        .regex(/^(0|[1-9]\d{0,77})$/)
        .optional()
        .openapi({ description: "Only this agent's rows, and stops of every agent." }),
    }),
  },
  responses: {
    200: {
      description: "The feed",
      content: { "application/json": { schema: z.object({ rows: z.array(Row) }) } },
    },
    401: { description: "Not signed in", content: problemContent },
  },
});

type Payload = { type?: string } & Record<string, unknown>;

const store = (id: string) => MERCHANTS.find((m) => m.id === id)?.name ?? id;

export function registerActivity(app: OpenAPIHono, deps: Pick<Deps, "db" | "verifyOrigin">): void {
  const { db } = deps;
  const verify = deps.verifyOrigin ?? "https://verify.keelson.finance";

  app.openapi(list, async (c) => {
    const me = { kind: "user" as const, subject: (c.get("principal") as Principal).subject };
    const mandatePrefix = principalChannel(me, "mandate:");
    const rows = await db
      .select()
      .from(events)
      .where(
        or(
          sql`${events.channel} = ${principalChannel(me, "agents")}`,
          sql`starts_with(${events.channel}, ${mandatePrefix})`,
        ),
      )
      .orderBy(desc(events.id))
      .limit(WINDOW);

    const payloads = rows.map((r) => r.payload as Payload);
    const purchaseIds = [
      ...new Set(payloads.flatMap((p) => (typeof p.purchaseId === "string" ? [p.purchaseId] : []))),
    ];
    const bought = purchaseIds.length
      ? await db.select().from(purchases).where(inArray(purchases.id, purchaseIds))
      : [];
    const mandateIds = [
      ...new Set([
        ...bought.map((p) => p.mandateId),
        ...rows.flatMap((r) => (r.channel.startsWith(mandatePrefix) ? [r.subjectId] : [])),
        ...rows.flatMap((r, i) => (payloads[i]?.type?.endsWith(".requested") ? [r.subjectId] : [])),
      ]),
    ].filter((id) => /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id));
    const owned = mandateIds.length
      ? await db.select().from(mandates).where(inArray(mandates.id, mandateIds))
      : [];
    const names = new Map<string, string>();
    for (const m of owned) names.set(m.id, await agentName(db, m.id, m.operatorAgentId));
    const stopIds = payloads.flatMap((p) =>
      p.type === "agents.stopped" && typeof p.stopId === "string" ? [p.stopId] : [],
    );
    const stops = stopIds.length
      ? await db.select().from(agentStops).where(inArray(agentStops.id, stopIds))
      : [];

    const out: z.infer<typeof Row>[] = [];
    const seen = new Set<string>();
    rows.forEach((r, i) => {
      const p = payloads[i] as Payload;
      const base = {
        id: r.id.toString(),
        at: r.createdAt.toISOString(),
        agentId: null as string | null,
        purchaseId: null as string | null,
        mandateId: null as string | null,
        href: null as string | null,
        alibiUrl: null as string | null,
        logIndex: null as string | null,
      };
      const mandate = owned.find((m) => m.id === r.subjectId);
      const ofMandate = (m: (typeof owned)[number] | undefined) =>
        m
          ? { agentId: m.operatorAgentId.toString(), mandateId: m.id, name: names.get(m.id) }
          : { agentId: null, mandateId: null, name: undefined };

      if (p.type === "approval.requested" || p.type === "change.requested") {
        const who = ofMandate(mandate);
        const name = typeof p.name === "string" ? p.name : (who.name ?? "Your agent");
        const currency = String(p.currency);
        out.push({
          ...base,
          agentId: who.agentId,
          mandateId: who.mandateId,
          tone: "warn",
          href: `/connect/?c=${String(p.userCode)}`,
          line:
            p.type === "approval.requested"
              ? `${name} asked you to approve ${money(String(p.amountMinor), currency)} at ${store(String(p.merchantId))}.`
              : `${name} asked for more room: up to ${money(String(p.totalMinor), currency)}.`,
        });
        return;
      }
      if (p.type === "agents.stopped") {
        const stop = stops.find((s) => s.id === p.stopId);
        const index = stop ? Object.values(stop.logIndexes)[0] : undefined;
        const n = Number(p.revoked ?? 0);
        out.push({
          ...base,
          tone: "bad",
          href: "/agents/",
          logIndex: index ?? null,
          line: `You stopped every agent: ${n} ${n === 1 ? "mandate" : "mandates"} ended.`,
        });
        return;
      }
      if (p.type === "agents.frozen" || p.type === "agent.disconnected") {
        out.push({
          ...base,
          tone: "bad",
          agentId: p.type === "agent.disconnected" ? r.subjectId : null,
          href: "/agents/",
          line:
            p.type === "agents.frozen"
              ? "You disconnected every agent."
              : "You disconnected an agent; its mandates ended.",
        });
        return;
      }
      if (p.type === "mandate.hold" && p.state === "ACTIVE" && mandate) {
        const who = ofMandate(mandate);
        out.push({
          ...base,
          agentId: who.agentId,
          mandateId: who.mandateId,
          tone: "good",
          href: `/mandate/?id=${mandate.id}`,
          line: `PayPal holds ${money(mandate.maxMinor, mandate.currency)} for ${who.name ?? "your agent"}.`,
        });
        return;
      }
      const buy = bought.find((b) => b.id === p.purchaseId);
      if (!buy || !p.type?.startsWith("purchase.")) return;
      // One row per purchase outcome: the mandate's channel repeats the purchase's own events.
      const key = `${buy.id}:${p.type}`;
      if (seen.has(key)) return;
      seen.add(key);
      const who = ofMandate(owned.find((m) => m.id === buy.mandateId));
      const name = who.name ?? "Your agent";
      const amount = money(buy.amountMinor, buy.currency);
      const at = store(buy.merchantId);
      const proof = {
        purchaseId: buy.id,
        agentId: who.agentId,
        mandateId: buy.mandateId,
        href: `/purchase/?mandate=${buy.mandateId}&id=${buy.id}`,
        logIndex: buy.logIndex?.toString() ?? null,
        alibiUrl: buy.logIndex === null ? null : `${verify}/a/${buy.id}`,
      };
      const line =
        p.type === "purchase.captured"
          ? (["good", `${name} bought ${amount} at ${at}.`] as const)
          : p.type === "purchase.denied"
            ? ([
                "bad",
                `Keelson blocked ${name}'s ${amount} cart at ${at}. Nothing was paid.`,
              ] as const)
            : p.type === "purchase.capture_denied"
              ? (["bad", `PayPal declined ${name}'s ${amount} payment at ${at}.`] as const)
              : p.type === "purchase.failed"
                ? p.step === "capture"
                  ? ([
                      "warn",
                      `We don't know yet whether ${name}'s ${amount} purchase at ${at} was charged. Don't start it again.`,
                    ] as const)
                  : ([
                      "bad",
                      `${name}'s ${amount} purchase at ${at} stopped before payment. Nothing was paid.`,
                    ] as const)
                : undefined;
      if (line) out.push({ ...base, ...proof, tone: line[0], line: line[1] });
    });

    const agent = c.req.valid("query").agent;
    return c.json(
      {
        rows: out.filter((r) => agent === undefined || r.agentId === null || r.agentId === agent),
      },
      200,
    );
  });
}
