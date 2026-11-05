import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { createQueries } from "@keelson/db";
import { streamSSE } from "hono/streaming";
import type { Deps } from "../app.ts";
import { eventsChannel } from "../events.ts";
import { requirePrincipal } from "../middleware/auth.ts";
import { ProblemSchema } from "../problem.ts";

const HEARTBEAT_MS = 15_000;
const BATCH = 100;

const route = createRoute({
  method: "get",
  path: "/v1/events",
  tags: ["events"],
  summary: "Stream events",
  description:
    "Server-sent events for one channel. Send `Last-Event-ID` to replay the events after that id before going live.",
  middleware: [requirePrincipal()],
  request: {
    query: z.object({ channel: z.string().min(1).max(200) }),
    headers: z.object({ "last-event-id": z.string().regex(/^\d+$/).optional() }),
  },
  responses: {
    200: {
      description: "An event stream; each event carries the row id, the channel and a JSON payload",
      content: { "text/event-stream": { schema: z.string() } },
    },
    401: {
      description: "Not authenticated",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export function registerEvents(app: OpenAPIHono, deps: Pick<Deps, "db" | "kv" | "log">): void {
  const queries = createQueries(deps.db);

  app.openapi(route, (c) => {
    const { channel } = c.req.valid("query");
    const lastEventId = c.req.valid("header")["last-event-id"];
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
        clearInterval(heartbeat);
        await subscriber.unsubscribe(topic).catch(() => {});
        await subscriber.close().catch(() => subscriber.destroy());
      }
    });
  });
}
