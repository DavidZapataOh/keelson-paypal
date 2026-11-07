import { and, type Db, eq, lt, purchases, sql } from "@keelson/db";
import type { Logger } from "pino";

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
