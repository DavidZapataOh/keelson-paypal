import { createRequire } from "node:module";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type Db, desc, eq, paypalEvents } from "@keelson/db";
import { LOG_HOST, LOG_ORIGINS } from "@keelson/log";
import type { Relayer } from "@keelson/relayer";
import type { RedisClientType } from "redis";
import { keccak256, stringToBytes } from "viem";
import { latestAnchor } from "../alibi/anchors.ts";
import { finalizedBlock } from "../chain/events.ts";
import type { ChainReaders } from "../chain/reader.ts";
import { rpcCalls } from "../chain/rpc.ts";
import type { LogConfig } from "../log/append.ts";
import type { PayPalDeps } from "../paypal.ts";
import type { TeeConfig } from "../tee/signers.ts";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

const Dependency = z.enum(["up", "down"]);

const route = createRoute({
  method: "get",
  path: "/status",
  operationId: "getStatus",
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
              paypal: z
                .object({ status: Dependency, environment: z.enum(["sandbox", "production"]) })
                .optional(),
              webhooks: z
                .object({
                  status: Dependency,
                  lastWebhookAgeMs: z.number().int().optional(),
                  lastPollAgeMs: z.number().int().optional(),
                })
                .optional(),
              chainEvents: z
                .object({
                  status: Dependency,
                  finalizedBlock: z.string().optional(),
                  reconciledAgeMs: z.number().int().optional(),
                })
                .optional(),
              anchor: z
                .object({
                  status: Dependency,
                  environment: z.literal("arbitrum-sepolia"),
                  size: z.string().optional(),
                  anchoredAgeMs: z.number().int().optional(),
                })
                .optional(),
            }),
            /** The chain RPC requests this process sent since it started. */
            rpc: z.object({
              calls: z.array(
                z.object({ provider: z.string(), method: z.string(), calls: z.number().int() }),
              ),
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

/** The poller records its cursor every 30 s; older than this, PayPal events are not being polled. */
const POLL_MAX_AGE_MS = 120_000;
const POLL_CURSOR = "paypal:poll:events";

const ageOf = (at: Date | string | null | undefined) =>
  at ? Math.max(0, Date.now() - new Date(at).getTime()) : undefined;

/** When PayPal last delivered a webhook, and when the poller last caught up. */
async function webhookState(db: Db, kv: RedisClientType) {
  const [[last], cursor] = await Promise.all([
    db
      .select({ at: paypalEvents.receivedAt })
      .from(paypalEvents)
      .where(eq(paypalEvents.source, "webhook"))
      .orderBy(desc(paypalEvents.receivedAt))
      .limit(1),
    kv.get(POLL_CURSOR),
  ]);
  const lastWebhookAgeMs = ageOf(last?.at);
  const lastPollAgeMs = ageOf(cursor);
  return {
    status:
      lastPollAgeMs !== undefined && lastPollAgeMs < POLL_MAX_AGE_MS
        ? ("up" as const)
        : ("down" as const),
    ...(lastWebhookAgeMs !== undefined ? { lastWebhookAgeMs } : {}),
    ...(lastPollAgeMs !== undefined ? { lastPollAgeMs } : {}),
  };
}

/** `state`, or `down` when it fails or takes longer than `timeoutMs`. */
async function within<T>(state: Promise<T>, timeoutMs: number): Promise<T | { status: "down" }> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<{ status: "down" }>((done) => {
    timer = setTimeout(() => done({ status: "down" }), timeoutMs);
  });
  try {
    return await Promise.race([state.catch(() => ({ status: "down" as const })), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long one PayPal probe answers for, so `/status` never spends the API's PayPal quota. */
const PAYPAL_PROBE_TTL_MS = 30_000;
const paypalProbes = new WeakMap<PayPalDeps, { at: number; status: Promise<"up" | "down"> }>();

/** An authenticated PayPal call, made at most once per `PAYPAL_PROBE_TTL_MS`. */
function paypalState(paypal: PayPalDeps): Promise<"up" | "down"> {
  let last = paypalProbes.get(paypal);
  if (!last || Date.now() - last.at > PAYPAL_PROBE_TTL_MS) {
    last = {
      at: Date.now(),
      status: probe(
        () =>
          paypal.paypal.fetch("GET", "/v1/notifications/webhooks", {
            timeoutMs: TEE_PROBE_TIMEOUT_MS,
          }),
        TEE_PROBE_TIMEOUT_MS,
      ),
    };
    paypalProbes.set(paypal, last);
  }
  return last.status;
}

/** The latest checkpoint of the sandbox log anchored on Arbitrum Sepolia, from the stored events. */
async function anchorState(db: Db) {
  const environment = "arbitrum-sepolia" as const;
  const latest = await latestAnchor(
    db,
    421614,
    keccak256(stringToBytes(LOG_ORIGINS[421614] as string)),
  );
  if (!latest) return { status: "down" as const, environment };
  return {
    status: "up" as const,
    environment,
    size: latest.size.toString(),
    anchoredAgeMs: Math.max(0, Date.now() - latest.seenAt.getTime()),
  };
}

/** The reconciler runs every five minutes; older than this, the stored events are falling behind. */
const RECONCILE_MAX_AGE_MS = 900_000;

/** How far the stored chain events are behind: the last finalized block read, and when. */
async function chainEventsState(db: Db) {
  const cursor = await finalizedBlock(db);
  if (!cursor) return { status: "down" as const };
  const reconciledAgeMs = Math.max(0, Date.now() - cursor.at.getTime());
  return {
    status: reconciledAgeMs < RECONCILE_MAX_AGE_MS ? ("up" as const) : ("down" as const),
    finalizedBlock: cursor.block.toString(),
    reconciledAgeMs,
  };
}

/** How long one relayer read answers for, so `/status` reads the chain at most this often. */
const RELAYER_PROBE_TTL_MS = 15_000;
const relayerProbes = new WeakMap<
  Relayer,
  { at: number; state: ReturnType<typeof relayerState> }
>();

function cachedRelayerState(relayer: Relayer) {
  let last = relayerProbes.get(relayer);
  if (!last || Date.now() - last.at > RELAYER_PROBE_TTL_MS) {
    last = { at: Date.now(), state: relayerState(relayer) };
    relayerProbes.set(relayer, last);
  }
  return last.state;
}

export function registerStatus(
  app: OpenAPIHono,
  deps: {
    db: Db;
    kv: RedisClientType;
    tee?: TeeConfig | undefined;
    tlog?: LogConfig | undefined;
    relayer?: Relayer | undefined;
    paypal?: PayPalDeps | undefined;
    chains?: ChainReaders | undefined;
  },
): void {
  app.openapi(route, async (c) => {
    const { tee, tlog, relayer, paypal, chains } = deps;
    const [db, kv, teeA, teeB, log, relayerDep, paypalDep, webhooks, anchor, events] =
      await Promise.all([
        probe(() => deps.db.execute("select 1")),
        probe(() => deps.kv.ping()),
        tee ? probe(() => tee.client.a.health(), TEE_PROBE_TIMEOUT_MS) : undefined,
        tee ? probe(() => tee.client.b.health(), TEE_PROBE_TIMEOUT_MS) : undefined,
        tlog ? logState(tlog).catch(() => ({ status: "down" as const, origins: [] })) : undefined,
        relayer ? cachedRelayerState(relayer) : undefined,
        paypal ? paypalState(paypal) : undefined,
        paypal ? within(webhookState(deps.db, deps.kv), PROBE_TIMEOUT_MS) : undefined,
        chains
          ? anchorState(deps.db).catch(() => ({
              status: "down" as const,
              environment: "arbitrum-sepolia" as const,
            }))
          : undefined,
        chains ? within(chainEventsState(deps.db), PROBE_TIMEOUT_MS) : undefined,
      ]);
    const up = [
      db,
      kv,
      teeA,
      teeB,
      log?.status,
      relayerDep?.status,
      paypalDep,
      webhooks?.status,
      anchor?.status,
      events?.status,
    ].every((d) => d === undefined || d === "up");
    return c.json(
      {
        status: up ? ("ok" as const) : ("degraded" as const),
        dependencies: {
          db,
          kv,
          ...(teeA && teeB ? { teeA, teeB } : {}),
          ...(log ? { log } : {}),
          ...(relayerDep ? { relayer: relayerDep } : {}),
          ...(paypal && paypalDep
            ? { paypal: { status: paypalDep, environment: paypal.environment } }
            : {}),
          ...(webhooks ? { webhooks } : {}),
          ...(anchor ? { anchor } : {}),
          ...(events ? { chainEvents: events } : {}),
        },
        rpc: { calls: rpcCalls() },
        version,
      },
      200,
    );
  });
}
