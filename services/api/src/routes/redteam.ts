import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { jcs } from "@keelson/core";
import { asc, attacks, type Db, desc, eq, redTeamCampaigns, sql } from "@keelson/db";
import { score } from "@keelson/redteam";
import { streamSSE } from "hono/streaming";
import type { Deps } from "../app.ts";
import { ProblemSchema, problem } from "../problem.ts";

const POLL_MS = 2_000;
const HEARTBEAT_MS = 15_000;
/** Per instance; the API runs as a single instance. */
const MAX_STREAMS = 200;
/** Finished campaigns' scoreboards kept in memory; they never change. */
const MAX_CACHED = 32;

const Id = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  .openapi({ description: "The campaign's ULID." });

const notFound = {
  description: "No such campaign",
  content: { "application/problem+json": { schema: ProblemSchema } },
};

const list = createRoute({
  method: "get",
  path: "/v1/redteam/campaigns",
  tags: ["red team"],
  summary: "Red-team campaigns",
  description: "The latest red-team campaigns, newest first. Public.",
  responses: {
    200: {
      description: "Up to 20 campaigns",
      content: {
        "application/json": {
          schema: z.object({
            campaigns: z.array(
              z.object({
                id: z.string(),
                startedAt: z.string(),
                finishedAt: z.string().nullable(),
                attacks: z.number().int(),
              }),
            ),
          }),
        },
      },
    },
  },
});

const ledger = createRoute({
  method: "get",
  path: "/v1/redteam/campaigns/{id}/ledger",
  tags: ["red team"],
  summary: "A campaign's ledger",
  description:
    "The campaign's hash-chained JSON Lines ledger, byte for byte: the header, one line per attack and, once finished, the summary. Each line is RFC 8785 JSON whose `prev` is the SHA-256 of `keelson/redteam/v1 ‖ 0x00 ‖ previous line`. Public.",
  request: { params: z.object({ id: Id }) },
  responses: {
    200: {
      description: "The ledger so far",
      content: { "application/jsonl": { schema: z.string() } },
    },
    404: notFound,
  },
});

const scoreboard = createRoute({
  method: "get",
  path: "/v1/redteam/campaigns/{id}/scoreboard",
  tags: ["red team"],
  summary: "A campaign's scoreboard",
  description:
    "Agent ASR, Keelson's escape rate with its Clopper-Pearson 95 % interval, false blocks and utility under attack with Wilson 95 % intervals, per backbone and split, computed from the ledger alone. The body is RFC 8785 JSON: recomputing it from the ledger gives the same bytes. Public.",
  request: { params: z.object({ id: Id }) },
  responses: {
    200: {
      description: "The scoreboard of the ledger so far",
      content: { "application/json": { schema: z.object({}).passthrough() } },
    },
    404: notFound,
  },
});

const stream = createRoute({
  method: "get",
  path: "/v1/redteam/campaigns/{id}/scoreboard/stream",
  tags: ["red team"],
  summary: "Follow a campaign's scoreboard",
  description:
    "Server-sent events: a `scoreboard` event with the current scoreboard, another each time the ledger grows, and `end` once the campaign is finished. Public.",
  request: { params: z.object({ id: Id }) },
  responses: {
    200: {
      description: "An event stream",
      content: { "text/event-stream": { schema: z.string() } },
    },
    404: notFound,
    503: {
      description: "Too many open streams",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

type Campaign = typeof redTeamCampaigns.$inferSelect;

async function campaign(db: Db, id: string): Promise<Campaign | undefined> {
  const [c] = await db.select().from(redTeamCampaigns).where(eq(redTeamCampaigns.id, id));
  return c;
}

/** The ledger lines of `c` as stored, in chain order. */
async function lines(db: Db, c: Campaign): Promise<string[]> {
  const rows = await db
    .select({ line: attacks.line })
    .from(attacks)
    .where(eq(attacks.campaign, c.id))
    .orderBy(asc(attacks.seq));
  return [c.header, ...rows.map((r) => r.line), ...(c.summary ? [c.summary] : [])];
}

/** How far `c`'s ledger has grown: its attack count and whether the summary is written. */
async function progress(db: Db, id: string): Promise<string> {
  const [p] = await db
    .select({
      n: sql<number>`(select count(*)::int from ${attacks} where ${attacks.campaign} = ${id})`,
      done: sql<boolean>`${redTeamCampaigns.summary} is not null`,
    })
    .from(redTeamCampaigns)
    .where(eq(redTeamCampaigns.id, id));
  return p ? `${p.n}:${p.done}` : "";
}

export function registerRedTeam(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "log" | "shutdown">,
): void {
  const { db } = deps;
  const finished = new Map<string, string>();
  let open = 0;

  /** The JCS scoreboard of `c`'s ledger as it stands. */
  const board = async (c: Campaign): Promise<string> => {
    const cached = finished.get(c.id);
    if (cached) return cached;
    const text = jcs(score(await lines(db, c)) as never);
    if (c.summary) {
      if (finished.size >= MAX_CACHED) finished.delete(finished.keys().next().value as string);
      finished.set(c.id, text);
    }
    return text;
  };

  const cacheFor = (c: Campaign) =>
    c.summary ? "public, max-age=31536000, immutable" : "no-store";

  app.openapi(list, async (c) => {
    const rows = await db
      .select({
        id: redTeamCampaigns.id,
        startedAt: redTeamCampaigns.createdAt,
        finishedAt: redTeamCampaigns.finishedAt,
        attacks: sql<number>`count(${attacks.id})::int`,
      })
      .from(redTeamCampaigns)
      .leftJoin(attacks, eq(attacks.campaign, redTeamCampaigns.id))
      .groupBy(redTeamCampaigns.id)
      .orderBy(desc(redTeamCampaigns.createdAt))
      .limit(20);
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        campaigns: rows.map((r) => ({
          id: r.id,
          startedAt: r.startedAt.toISOString(),
          finishedAt: r.finishedAt?.toISOString() ?? null,
          attacks: r.attacks,
        })),
      },
      200,
    );
  });

  app.openapi(ledger, async (c) => {
    const { id } = c.req.valid("param");
    const found = await campaign(db, id);
    if (!found) return problem(c, 404, "campaign-not-found", "Not found", "No such campaign.");
    const text = `${(await lines(db, found)).join("\n")}\n`;
    // Served as stored, byte for byte; the route documents the body as a string.
    return c.body(text, 200, {
      "Content-Type": "application/jsonl",
      "Content-Disposition": `attachment; filename="${id}.jsonl"`,
      "Cache-Control": cacheFor(found),
    }) as never;
  });

  app.openapi(scoreboard, async (c) => {
    const { id } = c.req.valid("param");
    const found = await campaign(db, id);
    if (!found) return problem(c, 404, "campaign-not-found", "Not found", "No such campaign.");
    // The JCS bytes themselves, not a re-serialization: they are what a recompute must match.
    return c.body(await board(found), 200, {
      "Content-Type": "application/json",
      "Cache-Control": cacheFor(found),
    }) as never;
  });

  app.openapi(stream, async (c) => {
    const { id } = c.req.valid("param");
    if (!(await campaign(db, id))) {
      return problem(c, 404, "campaign-not-found", "Not found", "No such campaign.");
    }
    if (open >= MAX_STREAMS) {
      return problem(c, 503, "too-many-streams", "Too many streams", "Try again later.");
    }
    open++;
    return streamSSE(c, async (sse) => {
      const end = (): void => sse.abort();
      deps.shutdown?.addEventListener("abort", end, { once: true });
      if (deps.shutdown?.aborted) end();
      const heartbeat = setInterval(() => {
        sse.write(": heartbeat\n\n").catch(() => {});
      }, HEARTBEAT_MS);
      let seen = "";
      try {
        while (!sse.aborted) {
          const now = await progress(db, id);
          if (now !== seen) {
            seen = now;
            const current = (await campaign(db, id)) as Campaign;
            await sse.writeSSE({ event: "scoreboard", data: await board(current) });
            if (current.summary) {
              await sse.writeSSE({ event: "end", data: "" });
              break;
            }
          }
          await sse.sleep(POLL_MS);
        }
      } catch (err) {
        deps.log.warn({ err }, "scoreboard stream failed");
      } finally {
        open--;
        clearInterval(heartbeat);
        deps.shutdown?.removeEventListener("abort", end);
      }
    });
  });
}
