import { createRequire } from "node:module";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "@keelson/db";
import type { RedisClientType } from "redis";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

const Dependency = z.enum(["up", "down"]);

const route = createRoute({
  method: "get",
  path: "/status",
  tags: ["system"],
  summary: "Dependency status",
  responses: {
    200: {
      description: "Status of the service and its dependencies; always 200",
      content: {
        "application/json": {
          schema: z.object({
            status: z.enum(["ok", "degraded"]),
            dependencies: z.object({ db: Dependency, kv: Dependency }),
            version: z.string(),
          }),
        },
      },
    },
  },
});

const PROBE_TIMEOUT_MS = 500;

async function probe(check: () => Promise<unknown>): Promise<"up" | "down"> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("probe timed out")), PROBE_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), deadline]);
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

export function registerStatus(app: OpenAPIHono, deps: { db: Db; kv: RedisClientType }): void {
  app.openapi(route, async (c) => {
    const [db, kv] = await Promise.all([
      probe(() => deps.db.execute("select 1")),
      probe(() => deps.kv.ping()),
    ]);
    const status = db === "up" && kv === "up" ? ("ok" as const) : ("degraded" as const);
    return c.json({ status, dependencies: { db, kv }, version }, 200);
  });
}
