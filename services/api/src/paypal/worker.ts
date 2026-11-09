import { and, asc, eq, paypalEvents, sql } from "@keelson/db";
import { PayPalError } from "@keelson/paypal";
import { type ApplyDeps, applyEvent, type EventRow } from "./apply.ts";

export interface PayPalEventWorker {
  /** Claims newly stored events now. */
  wake(): void;
  /** Stops sweeping and waits for the rounds in flight. */
  stop(): Promise<void>;
}

export interface PayPalEventWorkerOptions {
  sweepIntervalMs?: number;
  leaseMs?: number;
}

const BATCH = 16;
const SWEEP_INTERVAL_MS = 10_000;
/** Longer than the worst round: a batch whose rows each make a few PayPal reads of 15 s at most. */
const LEASE_MS = 300_000;
const MAX_ROUNDS_IN_FLIGHT = 2;
const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 600_000;
const GIVE_UP_MS = 24 * 60 * 60_000;
const FOREIGN_AFTER_ATTEMPTS = 3;

/** Retry delay after `attempts` failed rounds: 2 s · 4ⁿ⁻¹, at most ten minutes. */
const retryDelayMs = (attempts: number): number =>
  Math.min(FIRST_RETRY_MS * 4 ** (attempts - 1), MAX_RETRY_MS);

/**
 * Applies stored PayPal events off the request path. Each round leases due rows in one statement
 * (`FOR UPDATE SKIP LOCKED`), so two instances never apply one event at once, then re-reads each
 * resource from PayPal with no transaction open. An event PayPal could not be asked about is
 * retried with backoff for a day; a lease a crashed worker left behind is reclaimed by a sweep.
 */
export function startPayPalEventWorker(
  deps: ApplyDeps,
  options: PayPalEventWorkerOptions = {},
): PayPalEventWorker {
  const inFlight = new Set<Promise<void>>();
  let queued = false;
  let stopped = false;
  const leaseMs = options.leaseMs ?? LEASE_MS;

  const run = (): void => {
    if (stopped) return;
    if (inFlight.size >= MAX_ROUNDS_IN_FLIGHT) {
      queued = true;
      return;
    }
    const round: Promise<void> = claimAndApply(deps, leaseMs)
      .then(
        (claimed) => {
          if (claimed === BATCH) queued = true;
        },
        (err: unknown) => deps.log.error({ err }, "paypal event round failed"),
      )
      .finally(() => {
        inFlight.delete(round);
        if (queued) {
          queued = false;
          run();
        }
      });
    inFlight.add(round);
  };

  const timer = setInterval(run, options.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
  timer.unref();
  run();

  return {
    wake: run,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await Promise.all(inFlight);
    },
  };
}

async function claim(deps: ApplyDeps, lease: Date): Promise<EventRow[]> {
  const t = paypalEvents;
  const picked = deps.db
    .select({ id: t.id })
    .from(t)
    .where(
      sql`(${t.status} = 'received' and ${t.nextAttemptAt} <= now()) or (${t.status} = 'inflight' and ${t.leaseUntil} < now())`,
    )
    .orderBy(asc(t.nextAttemptAt))
    .limit(BATCH)
    .for("update", { skipLocked: true });
  return deps.db
    .update(t)
    .set({ status: "inflight", leaseUntil: lease })
    .where(sql`${t.id} in (${picked})`)
    .returning();
}

async function claimAndApply(deps: ApplyDeps, leaseMs: number): Promise<number> {
  const lease = new Date(Date.now() + leaseMs);
  const rows = await claim(deps, lease);
  const settle = async (row: EventRow): Promise<void> => {
    // Only the holder of the lease writes the outcome.
    const held = and(
      eq(paypalEvents.id, row.id),
      eq(paypalEvents.status, "inflight"),
      eq(paypalEvents.leaseUntil, lease),
    );
    try {
      const applied = await applyEvent(deps, row);
      await deps.db
        .update(paypalEvents)
        .set({
          status: applied.status,
          leaseUntil: null,
          attempts: row.attempts + 1,
          lastError: null,
          resource: (applied.resource ?? null) as never,
          resourceReadAt: applied.resource === undefined ? null : sql`now()`,
          ...(applied.purchaseId ? { purchaseId: applied.purchaseId } : {}),
          ...(applied.mandateId ? { mandateId: applied.mandateId } : {}),
          ...(applied.disputeId ? { disputeId: applied.disputeId } : {}),
          appliedAt: sql`now()`,
        })
        .where(held);
      deps.log.info(
        { eventId: row.id, eventType: row.eventType, status: applied.status },
        "paypal event applied",
      );
    } catch (err) {
      const attempts = row.attempts + 1;
      // PayPal answers 401 for another account's resource, as the simulator's; a token problem
      // would clear within a few tries.
      const foreign =
        err instanceof PayPalError && err.status === 401 && attempts >= FOREIGN_AFTER_ATTEMPTS;
      const giveUp = foreign || Date.now() - row.receivedAt.getTime() > GIVE_UP_MS;
      await deps.db
        .update(paypalEvents)
        .set({
          status: foreign ? "unresolvable" : giveUp ? "failed" : "received",
          leaseUntil: null,
          attempts,
          lastError: err instanceof Error ? err.message.slice(0, 500) : String(err),
          nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)),
        })
        .where(held);
      deps.log[giveUp ? "error" : "warn"](
        { err, eventId: row.id, eventType: row.eventType, attempts },
        foreign
          ? "paypal event names a resource this app cannot read"
          : giveUp
            ? "paypal event failed for 24 h"
            : "paypal event will be retried",
      );
    }
  };
  const settled = await Promise.allSettled(rows.map(settle));
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      deps.log.error({ err: outcome.reason }, "paypal event could not be settled");
    }
  }
  return rows.length;
}
