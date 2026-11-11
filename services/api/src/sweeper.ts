import { and, type Db, eq, lt, purchases, sql } from "@keelson/db";
import type { Logger } from "pino";
import { resumeSettlements, type SettleDeps } from "./disputes/settle.ts";
import { closeExpiredCards } from "./pipeline/card-step.ts";
import { logDenials, type PipelineDeps, resumePurchases } from "./pipeline/drive.ts";
import { finishStops } from "./stop.ts";

/** A countersign that has not finished by now was lost with its process; the request timeout is 30 s. */
const STALE_AFTER_MS = 120_000;
const SWEEP_INTERVAL_MS = 30_000;

/**
 * Fails the purchases left in `EVALUATING`, which can then be driven again. Returns how many.
 *
 * @internal
 */
export async function failStalePurchases(db: Db, now: Date = new Date()): Promise<number> {
  const result = await db
    .update(purchases)
    .set({ state: "FAILED", failureReason: "stale", updatedAt: sql`now()` })
    .where(
      and(
        eq(purchases.state, "EVALUATING"),
        lt(purchases.updatedAt, new Date(now.getTime() - STALE_AFTER_MS)),
      ),
    );
  return result.rowCount ?? 0;
}

export function startPurchaseSweeper(deps: { db: Db; log: Logger }): () => void {
  const timer = setInterval(() => {
    failStalePurchases(deps.db).then(
      (count) => {
        if (count > 0) deps.log.warn({ count }, "stale purchases failed");
      },
      (err: unknown) => deps.log.error({ err }, "purchase sweep failed"),
    );
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

const RESUME_INTERVAL_MS = 5_000;

/**
 * Every five seconds, drives the purchases whose driver is gone, logs DENYs not yet logged and
 * finishes stops of every agent and closes the single-use cards whose countersign expired unused.
 */
export function startPipelineResumer(deps: PipelineDeps): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void Promise.all([
      resumePurchases(deps),
      logDenials(deps),
      finishStops({
        db: deps.db,
        kv: deps.kv,
        log: deps.log,
        ...(deps.paypal ? { paypal: deps.paypal } : {}),
        ...(deps.tlog ? { tlog: deps.tlog } : {}),
      }),
      closeExpiredCards(deps),
    ])
      .then(
        ([resumed, logged, stops, closed]) => {
          if (resumed + logged + stops + closed > 0) {
            deps.log.info({ resumed, logged, stops, closed }, "purchases resumed");
          }
        },
        (err: unknown) => deps.log.error({ err }, "purchase resume failed"),
      )
      .finally(() => {
        running = false;
      });
  }, RESUME_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

const SETTLE_INTERVAL_MS = 15_000;

/** Every 15 seconds, settles again the verdicts waiting on a veto window, a payout or a lost run. */
export function startSettlementSweeper(deps: SettleDeps): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void resumeSettlements(deps)
      .then(
        (count) => {
          if (count > 0) deps.log.info({ count }, "settlements resumed");
        },
        (err: unknown) => deps.log.error({ err }, "settlement sweep failed"),
      )
      .finally(() => {
        running = false;
      });
  }, SETTLE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
