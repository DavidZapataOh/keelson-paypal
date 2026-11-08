import { createRequire } from "node:module";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Db } from "@keelson/db";
import { LOG_HOST, LOG_ORIGINS } from "@keelson/log";
import type { Relayer } from "@keelson/relayer";
import type { RedisClientType } from "redis";
import type { LogConfig } from "../log/append.ts";
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
              relayer: z
                .object({
                  status: z.enum(["up", "down", "degraded"]),
                  chains: z.array(
                    z.object({
                      chainId: z.number().int(),
                      status: z.enum(["up", "down", "degraded"]),
                      address: z.string(),
                      balanceWei: z.string().optional(),
                      nextNonce: z.string().optional(),
                      pending: z.number().int(),
                      baseFeeWei: z.string().optional(),
                    }),
                  ),
                })
                .optional(),
              log: z
                .object({
                  status: Dependency,
                  origins: z.array(
                    z.object({
                      origin: z.string(),
                      size: z.number().int(),
                      checkpointAgeMs: z.number().int(),
                    }),
                  ),
                })
                .optional(),
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

/** A checkpoint older than this means the log stopped publishing; it republishes every minute. */
const CHECKPOINT_MAX_AGE_MS = 120_000;

/** The size and age of each origin's latest checkpoint, read over the private network. */
async function logState(tlog: LogConfig) {
  const origins = await Promise.all(
    Object.values(LOG_ORIGINS).map(async (origin) => {
      const path = origin.slice(LOG_HOST.length + 1);
      const res = await fetch(`${tlog.url.replace(/\/$/, "")}/${path}/checkpoint`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`checkpoint: ${res.status}`);
      const size = Number((await res.text()).split("\n")[1]);
      const modified = Date.parse(res.headers.get("last-modified") ?? "");
      if (!Number.isSafeInteger(size) || Number.isNaN(modified)) throw new Error("bad checkpoint");
      return { origin, size, checkpointAgeMs: Math.max(0, Date.now() - modified) };
    }),
  );
  const fresh = origins.every((o) => o.checkpointAgeMs < CHECKPOINT_MAX_AGE_MS);
  return { status: fresh ? ("up" as const) : ("down" as const), origins };
}

/** Each chain's relayer: its address, balance, next nonce and the calls still pending. */
async function relayerState(relayer: Relayer) {
  const chains = await Promise.all(
    relayer.chains().map(async (chainId) => {
      const s = await relayer.status(chainId);
      return {
        chainId: s.chainId,
        status: s.status,
        address: s.address,
        ...(s.balanceWei !== undefined ? { balanceWei: s.balanceWei.toString() } : {}),
        ...(s.nextNonce !== undefined ? { nextNonce: s.nextNonce.toString() } : {}),
        pending: s.pending,
        ...(s.baseFeeWei !== undefined ? { baseFeeWei: s.baseFeeWei.toString() } : {}),
      };
    }),
  );
  const status = chains.some((c) => c.status === "down")
    ? ("down" as const)
    : chains.some((c) => c.status === "degraded")
      ? ("degraded" as const)
      : ("up" as const);
  return { status, chains };
}

export function registerStatus(
  app: OpenAPIHono,
  deps: {
    db: Db;
    kv: RedisClientType;
    tee?: TeeConfig | undefined;
    tlog?: LogConfig | undefined;
    relayer?: Relayer | undefined;
  },
): void {
  app.openapi(route, async (c) => {
    const { tee, tlog, relayer } = deps;
    const [db, kv, teeA, teeB, log, relayerDep] = await Promise.all([
      probe(() => deps.db.execute("select 1")),
      probe(() => deps.kv.ping()),
      tee ? probe(() => tee.client.a.health(), TEE_PROBE_TIMEOUT_MS) : undefined,
      tee ? probe(() => tee.client.b.health(), TEE_PROBE_TIMEOUT_MS) : undefined,
      tlog ? logState(tlog).catch(() => ({ status: "down" as const, origins: [] })) : undefined,
      relayer ? relayerState(relayer) : undefined,
    ]);
    const up = [db, kv, teeA, teeB, log?.status, relayerDep?.status].every(
      (d) => d === undefined || d === "up",
    );
    return c.json(
      {
        status: up ? ("ok" as const) : ("degraded" as const),
        dependencies: {
          db,
          kv,
          ...(teeA && teeB ? { teeA, teeB } : {}),
          ...(log ? { log } : {}),
          ...(relayerDep ? { relayer: relayerDep } : {}),
        },
        version,
      },
      200,
    );
  });
}
