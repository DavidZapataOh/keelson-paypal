import { and, asc, type Db, eq, sql, timestamps } from "@keelson/db";
import {
  requestTimestamp,
  TimestampError,
  TSAS,
  type TsaId,
  verifyTimestamp,
} from "@keelson/timestamp";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import { publishEvent } from "../events.ts";

export interface StampWorker {
  /** Claims newly queued rows now. */
  wake(): void;
  /** Stops sweeping and waits for the rounds in flight. */
  stop(): Promise<void>;
}

export interface StampWorkerOptions {
  /** Endpoint overrides, from `TSA_*_URL`. */
  urls?: Partial<Record<TsaId, string>>;
  timeoutMs?: number;
  sweepIntervalMs?: number;
}

type Row = typeof timestamps.$inferSelect;

const BATCH = 32;
const MAX_ROUNDS_IN_FLIGHT = 4;
const RETRY_DELAYS_MS = [200, 800];
/** Rounds a primary fails before its fallback is asked. */
const ROUNDS_BEFORE_FALLBACK = 3;
const GIVE_UP_MS = 24 * 60 * 60_000;
const FALLBACK: Partial<Record<TsaId, TsaId>> = { digicert: "freetsa", sigstore: "sectigo" };
const EVENTS = "public:timestamps";

/** Earliest next request per rate-limited TSA, for this process. */
const nextRequestAt = new Map<TsaId, number>();

/**
 * Stamps queued hashes off the request path. Each round claims pending rows with
 * `FOR UPDATE SKIP LOCKED`, so API instances and the sweeper never ask twice for one
 * `(hash, tsa)`; the TSAs of a hash are asked in parallel and every token is verified before it
 * is stored. The sweeper retries what an outage or a crash left pending.
 */
export function startStampWorker(
  deps: { db: Db; kv: RedisClientType; log: Logger },
  options: StampWorkerOptions = {},
): StampWorker {
  const inFlight = new Set<Promise<void>>();
  let rerun = false;
  let stopped = false;

  const run = (fresh: boolean): void => {
    if (stopped) return;
    if (inFlight.size >= MAX_ROUNDS_IN_FLIGHT) {
      rerun = true;
      return;
    }
    const round: Promise<void> = claimAndStamp(deps, options, fresh)
      .catch((err: unknown) => deps.log.error({ err }, "timestamp round failed"))
      .finally(() => {
        inFlight.delete(round);
        if (rerun) {
          rerun = false;
          run(true);
        }
      });
    inFlight.add(round);
  };

  const timer = setInterval(() => run(false), options.sweepIntervalMs ?? 30_000);
  timer.unref();
  run(false);

  return {
    wake: () => run(true),
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await Promise.all(inFlight);
    },
  };
}

async function claimAndStamp(
  deps: { db: Db; kv: RedisClientType; log: Logger },
  options: StampWorkerOptions,
  fresh: boolean,
): Promise<void> {
  const failed: Row[] = [];
  await deps.db.transaction(async (tx) => {
    const pending = eq(timestamps.status, "pending");
    const rows = await tx
      .select()
      .from(timestamps)
      // A wake takes only rows never tried, so new hashes do not wait behind retries.
      .where(fresh ? and(pending, eq(timestamps.attempts, 0)) : pending)
      .orderBy(asc(timestamps.createdAt))
      .limit(BATCH)
      .for("update", { skipLocked: true });

    await Promise.all(
      rows.map(async (row) => {
        const key = and(eq(timestamps.hash, row.hash), eq(timestamps.tsa, row.tsa));
        if (Date.now() - row.createdAt.getTime() > GIVE_UP_MS) {
          await tx.update(timestamps).set({ status: "failed" }).where(key);
          failed.push(row);
          return;
        }
        const tsa = row.tsa as TsaId;
        const result = await stamp(tsa, row.hash, options);
        if (result === "deferred") return;
        if ("token" in result) {
          await tx
            .update(timestamps)
            .set({
              status: "stamped",
              token: Buffer.from(result.token),
              genTime: result.genTime,
              serial: result.serial,
              latencyMs: result.latencyMs,
              attempts: row.attempts + 1,
              lastError: null,
              stampedAt: sql`clock_timestamp()`,
            })
            .where(key);
          return;
        }
        const attempts = row.attempts + 1;
        const fallback = row.role === "primary" ? FALLBACK[tsa] : undefined;
        const replace = fallback !== undefined && attempts >= ROUNDS_BEFORE_FALLBACK;
        await tx
          .update(timestamps)
          .set({ attempts, lastError: result.error, ...(replace ? { status: "failed" } : {}) })
          .where(key);
        if (replace) {
          await tx
            .insert(timestamps)
            .values({ hash: row.hash, kind: row.kind, tsa: fallback, role: "fallback" })
            .onConflictDoNothing();
          deps.log.warn({ tsa, fallback, error: result.error }, "timestamp fallback requested");
        }
      }),
    );
  });

  for (const row of failed) {
    const hash = row.hash.toString("hex");
    deps.log.error({ hash, tsa: row.tsa }, "timestamp failed for 24 h");
    await publishEvent(deps, EVENTS, hash, {
      type: "timestamp.failed",
      hash,
      tsa: row.tsa,
      kind: row.kind,
    }).catch((err: unknown) => deps.log.error({ err }, "timestamp event could not be published"));
  }
}

type Outcome =
  | { token: Uint8Array; genTime: Date; serial: string; latencyMs: number }
  | { error: string }
  | "deferred";

/** Asks one TSA, retrying with backoff, and verifies the token before it is kept. */
async function stamp(tsa: TsaId, hash: Uint8Array, options: StampWorkerOptions): Promise<Outcome> {
  const { minIntervalMs } = TSAS[tsa];
  const tries = minIntervalMs > 0 ? 1 : RETRY_DELAYS_MS.length + 1;
  if (minIntervalMs > 0) {
    if (Date.now() < (nextRequestAt.get(tsa) ?? 0)) return "deferred";
    nextRequestAt.set(tsa, Date.now() + minIntervalMs);
  }
  const url = options.urls?.[tsa] ?? TSAS[tsa].url;
  let error = "tsa-error";
  for (let i = 0; i < tries; i++) {
    if (i > 0) await jitteredDelay(RETRY_DELAYS_MS[i - 1] as number);
    try {
      const timeout = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
      const stamped = await requestTimestamp({ id: tsa, url }, hash, timeout);
      await verifyTimestamp(stamped.token, hash);
      return stamped;
    } catch (err) {
      error = err instanceof TimestampError ? err.code : "tsa-error";
    }
  }
  return { error };
}

function jitteredDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms * (0.8 + Math.random() * 0.4)));
}
