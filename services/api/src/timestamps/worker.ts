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
  /** How long a failed row waits before a sweep may take it again. */
  retryAfterMs?: number;
}

type Row = typeof timestamps.$inferSelect;

const BATCH = 32;
const SWEEP_INTERVAL_MS = 30_000;
const RETRY_AFTER_MS = 30_000;
/** Longer than the worst round: 3 tries of 2 s, the backoff and verification. */
const LEASE_MS = 30_000;
const VERIFY_DEADLINE_MS = 2_000;
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
 * Stamps queued hashes off the request path. Each round leases due rows in one statement
 * (`FOR UPDATE SKIP LOCKED`), so API instances and the sweeper never ask twice for one
 * `(hash, tsa)`, then asks the TSAs with no transaction open: the TSAs of a hash in parallel,
 * every token verified as coming from the TSA asked before it is stored. The sweeper retries
 * what an outage left pending and reclaims rows whose lease a crashed worker left behind.
 */
export function startStampWorker(
  deps: { db: Db; kv: RedisClientType; log: Logger },
  options: StampWorkerOptions = {},
): StampWorker {
  const inFlight = new Set<Promise<void>>();
  /** The round to run once one finishes: a wake (new rows only) or a sweep (all pending). */
  let queued: "wake" | "sweep" | null = null;
  let stopped = false;

  const run = (fresh: boolean): void => {
    if (stopped) return;
    if (inFlight.size >= MAX_ROUNDS_IN_FLIGHT) {
      if (queued !== "sweep") queued = fresh ? "wake" : "sweep";
      return;
    }
    const round: Promise<void> = claimAndStamp(deps, options, fresh)
      .then(
        // A full batch worked means more rows are waiting: keep draining.
        (claimed) => {
          if (claimed === BATCH && queued !== "sweep") queued = fresh ? "wake" : "sweep";
        },
        (err: unknown) => deps.log.error({ err }, "timestamp round failed"),
      )
      .finally(() => {
        inFlight.delete(round);
        const next = queued;
        queued = null;
        if (next) run(next === "wake");
      });
    inFlight.add(round);
  };

  const timer = setInterval(() => run(false), options.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
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

/** Claims up to a batch with a lease, in one statement of its own: no transaction stays open. */
async function claim(db: Db, fresh: boolean, lease: Date): Promise<Row[]> {
  const t = timestamps;
  const due = sql`${t.status} = 'pending' and ${t.nextAttemptAt} <= now()`;
  // A wake takes only rows never tried, so new hashes do not wait behind retries; a sweep also
  // takes rows whose worker lost its lease.
  const eligible = fresh
    ? sql`${due} and ${t.attempts} = 0`
    : sql`(${due}) or (${t.status} = 'inflight' and ${t.leaseUntil} < now())`;
  const picked = db
    .select({ hash: t.hash, tsa: t.tsa })
    .from(t)
    .where(eligible)
    .orderBy(asc(t.nextAttemptAt))
    .limit(BATCH)
    .for("update", { skipLocked: true });
  return db
    .update(t)
    .set({ status: "inflight", leaseUntil: lease })
    .where(sql`(${t.hash}, ${t.tsa}) in (${picked})`)
    .returning();
}

async function claimAndStamp(
  deps: { db: Db; kv: RedisClientType; log: Logger },
  options: StampWorkerOptions,
  fresh: boolean,
): Promise<number> {
  const lease = new Date(Date.now() + LEASE_MS);
  const rows = await claim(deps.db, fresh, lease);
  const retryAfterMs = options.retryAfterMs ?? RETRY_AFTER_MS;
  let deferred = 0;

  const settle = async (row: Row): Promise<void> => {
    // Only the holder of the lease writes the outcome.
    const held = and(
      eq(timestamps.hash, row.hash),
      eq(timestamps.tsa, row.tsa),
      eq(timestamps.status, "inflight"),
      eq(timestamps.leaseUntil, lease),
    );
    const release = { leaseUntil: null };
    if (Date.now() - row.createdAt.getTime() > GIVE_UP_MS) {
      await deps.db
        .update(timestamps)
        .set({ status: "failed", ...release })
        .where(held);
      await announceFailure(deps, row);
      return;
    }
    const tsa = row.tsa as TsaId;
    const result = await stamp(tsa, row.hash, options);
    if ("deferUntil" in result) {
      deferred++;
      await deps.db
        .update(timestamps)
        .set({ status: "pending", nextAttemptAt: result.deferUntil, ...release })
        .where(held);
      return;
    }
    if ("token" in result) {
      await deps.db
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
          ...release,
        })
        .where(held);
      return;
    }
    const attempts = row.attempts + 1;
    const fallback = row.role === "primary" ? FALLBACK[tsa] : undefined;
    const replace = fallback !== undefined && attempts >= ROUNDS_BEFORE_FALLBACK;
    await deps.db
      .update(timestamps)
      .set({
        status: replace ? "failed" : "pending",
        attempts,
        lastError: result.error,
        nextAttemptAt: new Date(Date.now() + retryAfterMs),
        ...release,
      })
      .where(held);
    if (replace) {
      await deps.db
        .insert(timestamps)
        .values({ hash: row.hash, kind: row.kind, tsa: fallback, role: "fallback" })
        .onConflictDoNothing();
      deps.log.warn({ tsa, fallback, error: result.error }, "timestamp fallback requested");
    }
  };

  const settled = await Promise.allSettled(rows.map(settle));
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      deps.log.error({ err: outcome.reason }, "timestamp row could not be settled");
    }
  }
  return rows.length - deferred;
}

async function announceFailure(
  deps: { db: Db; kv: RedisClientType; log: Logger },
  row: Row,
): Promise<void> {
  const hash = row.hash.toString("hex");
  deps.log.error({ hash, tsa: row.tsa }, "timestamp failed for 24 h");
  await publishEvent(deps, EVENTS, hash, {
    type: "timestamp.failed",
    hash,
    tsa: row.tsa,
    kind: row.kind,
  }).catch((err: unknown) => deps.log.error({ err }, "timestamp event could not be published"));
}

type Outcome =
  | { token: Uint8Array; genTime: Date; serial: string; latencyMs: number }
  | { error: string }
  | { deferUntil: Date };

/** Asks one TSA, retrying with backoff, and verifies the token before it is kept. */
async function stamp(tsa: TsaId, hash: Uint8Array, options: StampWorkerOptions): Promise<Outcome> {
  const { minIntervalMs } = TSAS[tsa];
  const tries = minIntervalMs > 0 ? 1 : RETRY_DELAYS_MS.length + 1;
  if (minIntervalMs > 0) {
    const next = nextRequestAt.get(tsa) ?? 0;
    if (Date.now() < next) return { deferUntil: new Date(next) };
    nextRequestAt.set(tsa, Date.now() + minIntervalMs);
  }
  const url = options.urls?.[tsa] ?? TSAS[tsa].url;
  let error = "tsa-error";
  for (let i = 0; i < tries; i++) {
    if (i > 0) await jitteredDelay(RETRY_DELAYS_MS[i - 1] as number);
    try {
      const timeout = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
      const stamped = await requestTimestamp({ id: tsa, url }, hash, timeout);
      // Only a token from the TSA asked counts; a hostile token cannot hold the worker.
      await withDeadline(
        verifyTimestamp(stamped.token, hash, { expectedTsa: tsa }),
        VERIFY_DEADLINE_MS,
      );
      return stamped;
    } catch (err) {
      error = err instanceof TimestampError ? err.code : "tsa-error";
    }
  }
  return { error };
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimestampError("tsa-timeout", "token verification took too long")),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function jitteredDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms * (0.8 + Math.random() * 0.4)));
}
