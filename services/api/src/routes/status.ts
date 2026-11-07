import { createRequire } from "node:module";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "@keelson/db";
import type { RedisClientType } from "redis";
import type { TeeConfig } from "../tee/signers.ts";

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
            dependencies: z.object({
              db: Dependency,
              kv: Dependency,
              teeA: Dependency.optional(),
              teeB: Dependency.optional(),
            }),
            version: z.string(),
          }),
        },
      },
    },
  },
});

const PROBE_TIMEOUT_MS = 500;
/** The legs are remote and one reads the chain to answer, so they get longer. */
const TEE_PROBE_TIMEOUT_MS = 2_000;

async function probe(
  check: () => Promise<unknown>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<"up" | "down"> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("probe timed out")), timeoutMs);
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

export function registerStatus(
  app: OpenAPIHono,
  deps: { db: Db; kv: RedisClientType; tee?: TeeConfig | undefined },
): void {
  app.openapi(route, async (c) => {
    const { tee } = deps;
    const [db, kv, teeA, teeB] = await Promise.all([
      probe(() => deps.db.execute("select 1")),
      probe(() => deps.kv.ping()),
      tee ? probe(() => tee.client.a.health(), TEE_PROBE_TIMEOUT_MS) : undefined,
      tee ? probe(() => tee.client.b.health(), TEE_PROBE_TIMEOUT_MS) : undefined,
    ]);
    const up = [db, kv, teeA, teeB].every((d) => d === undefined || d === "up");
    return c.json(
      {
        status: up ? ("ok" as const) : ("degraded" as const),
        dependencies: { db, kv, ...(teeA && teeB ? { teeA, teeB } : {}) },
        version,
      },
      200,
    );
  });
}
