import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { createQueries } from "@keelson/db";
import { streamSSE } from "hono/streaming";
import type { Deps } from "../app.ts";
import { eventsChannel } from "../events.ts";
import { requirePrincipal } from "../middleware/auth.ts";
import type { Principal } from "../middleware/idempotency.ts";
import { ProblemSchema, problem } from "../problem.ts";

const HEARTBEAT_MS = 15_000;
const BATCH = 100;
const MAX_STREAMS_PER_PRINCIPAL = 5;
const MAX_EVENT_ID = 2n ** 63n - 1n;
const CHANNEL = /^[A-Za-z0-9:_-]{1,128}$/;
const EVENT_ID = /^\d{1,19}$/;

function mayRead(principal: { kind: string; subject: string }, channel: string): boolean {
  if (channel.startsWith("public:") && channel.length > "public:".length) return true;
  const namespace = `${principal.kind}:${Buffer.from(principal.subject).toString("base64url")}`;
  return channel === namespace || channel.startsWith(`${namespace}:`);
}

const route = createRoute({
  method: "get",
  path: "/v1/events",
  tags: ["events"],
  summary: "Stream events",
  description:
    "Server-sent events for one channel. Send `Last-Event-ID` to replay the events after that id before going live.",
  middleware: [requirePrincipal()],
  request: {
    query: z.object({
      channel: z.string().openapi({
        description:
          "`public:<name>`, or the caller's own namespace `<kind>:<base64url(subject)>` with an optional `:<suffix>`.",
      }),
    }),
    headers: z.object({ "last-event-id": z.string().optional() }),
  },
  responses: {
    200: {
      description: "An event stream; each event carries the row id, the channel and a JSON payload",
      content: { "text/event-stream": { schema: z.string() } },
    },
    400: {
      description: "Invalid channel or Last-Event-ID",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
      description: "The channel belongs to another principal",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    429: {
      description: "Too many concurrent streams for this principal",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    401: {
      description: "Not authenticated",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export function registerEvents(app: OpenAPIHono, deps: Pick<Deps, "db" | "kv" | "log">): void {
  const queries = createQueries(deps.db);
  // Per-instance count; the API runs as a single instance.
  const streams = new Map<string, number>();

  app.openapi(route, (c) => {
    const { channel } = c.req.valid("query");
    const lastEventId = c.req.valid("header")["last-event-id"];
    const principal = c.get("principal") as Principal;
    if (!CHANNEL.test(channel)) {
      return problem(
        c,
        400,
        "invalid-channel",
        "Invalid channel",
        "Use 1 to 128 of A-Z a-z 0-9 : _ -.",
      );
    }
    if (!mayRead(principal, channel)) {
      return problem(c, 403, "forbidden-channel", "Forbidden channel");
    }
    if (
      lastEventId !== undefined &&
      !(EVENT_ID.test(lastEventId) && BigInt(lastEventId) <= MAX_EVENT_ID)
    ) {
      return problem(c, 400, "invalid-last-event-id", "Invalid Last-Event-ID");
    }
    const owner = `${principal.kind}:${principal.subject}`;
    const open = streams.get(owner) ?? 0;
    if (open >= MAX_STREAMS_PER_PRINCIPAL) {
      return problem(
        c,
        429,
        "too-many-streams",
        "Too many streams",
        `At most ${MAX_STREAMS_PER_PRINCIPAL} concurrent streams.`,
      );
    }
    streams.set(owner, open + 1);
    const topic = eventsChannel(channel);

    return streamSSE(c, async (stream) => {
      const subscriber = deps.kv.duplicate();
      subscriber.on("error", (err) => deps.log.warn({ err }, "event subscriber error"));
      let cursor = lastEventId === undefined ? undefined : BigInt(lastEventId);
      let draining = false;
      let again = false;

      // Notifications carry only an id, so every one triggers a read past the cursor. The cursor
      // makes replay and live delivery one ordered sequence: nothing is skipped or repeated.
      const drain = async (): Promise<void> => {
        if (draining) {
          again = true;
          return;
        }
        draining = true;
        try {
          do {
            again = false;
            for (;;) {
              const rows = await queries.eventsAfter(channel, cursor ?? 0n, BATCH);
              for (const row of rows) {
                await stream.writeSSE({
                  id: String(row.id),
                  event: channel,
                  data: JSON.stringify(row.payload),
                });
                cursor = row.id;
              }
              if (rows.length < BATCH) break;
            }
          } while (again);
        } catch (err) {
          deps.log.warn({ err }, "event delivery failed");
          stream.abort();
        } finally {
          draining = false;
        }
      };

      const closed = new Promise<void>((resolve) => stream.onAbort(resolve));
      const heartbeat = setInterval(() => {
        stream.write(": heartbeat\n\n").catch(() => {});
        if (cursor !== undefined) void drain();
      }, HEARTBEAT_MS);

      try {
        await subscriber.connect();
        await subscriber.subscribe(topic, (message) => {
          // Without a cursor the stream is live-only: start just before the first new event.
          cursor ??= BigInt(message) - 1n;
          void drain();
        });
        await stream.write(": connected\n\n");
        if (cursor !== undefined) await drain();
        await closed;
      } finally {
        const left = (streams.get(owner) ?? 1) - 1;
        if (left <= 0) streams.delete(owner);
        else streams.set(owner, left);
        clearInterval(heartbeat);
        await subscriber.unsubscribe(topic).catch(() => {});
        await subscriber.close().catch(() => subscriber.destroy());
      }
    });
  });
}
