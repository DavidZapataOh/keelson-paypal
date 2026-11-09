import { sql } from "@keelson/db";
import {
  eventResourceId,
  getDispute,
  listUpdatedDisputes,
  listWebhookEvents,
  type PayPalFetch,
} from "@keelson/paypal";
import { type ApplyDeps, applyDispute } from "./apply.ts";
import { storeDelivery } from "./webhook.ts";

export interface PayPalPoller {
  stop(): Promise<void>;
}

const INTERVAL_MS = 30_000;
/** Each round looks back this far past its cursor, for events PayPal records late. */
const OVERLAP_MS = 5 * 60_000;
/** The first round, and a round after a long outage, look back at most a day. */
const MAX_LOOKBACK_MS = 24 * 60 * 60_000;
const EVENTS_CURSOR = "paypal:poll:events";
const DISPUTES_CURSOR = "paypal:poll:disputes";

/**
 * Catches what webhooks missed: every round lists the app's events since the cursor and stores the
 * ones not yet stored for the worker, and re-reads every dispute updated since its cursor. One
 * instance polls at a time: the round runs under a transaction-scoped advisory lock.
 */
export function startPayPalPoller(
  deps: ApplyDeps & { paypalEvents?: { wake(): void } | undefined },
  options: { intervalMs?: number } = {},
): PayPalPoller {
  let current: Promise<unknown> | undefined;
  let stopped = false;
  const tick = (): void => {
    if (stopped || current) return;
    current = pollOnce(deps)
      .catch((err: unknown) => deps.log.warn({ err }, "paypal poll round failed"))
      .finally(() => {
        current = undefined;
      });
  };
  const timer = setInterval(tick, options.intervalMs ?? INTERVAL_MS);
  timer.unref();
  tick();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await current;
    },
  };
}

/**
 * One round; resolves to `false` when another instance holds the round.
 *
 * @internal
 */
export async function pollOnce(
  deps: ApplyDeps & { paypalEvents?: { wake(): void } | undefined },
): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext('paypal-poll')) as locked`,
    );
    if (!rows[0]?.locked) return false;
    await deps.kv.incr("paypal:poll:rounds");
    const f = deps.paypal.paypal.fetch;
    const now = new Date();
    const stored = await pollEvents(deps, f, now);
    if (stored > 0) deps.paypalEvents?.wake();
    await pollDisputes(deps, f, now);
    return true;
  });
}

async function since(deps: ApplyDeps, key: string, now: Date): Promise<Date> {
  const cursor = await deps.kv.get(key);
  const floor = now.getTime() - MAX_LOOKBACK_MS;
  const from = cursor ? new Date(cursor).getTime() - OVERLAP_MS : floor;
  return new Date(Math.max(Number.isNaN(from) ? floor : from, floor));
}

async function pollEvents(deps: ApplyDeps, f: PayPalFetch, now: Date): Promise<number> {
  const events = await listWebhookEvents(f, {
    startTime: await since(deps, EVENTS_CURSOR, now),
    endTime: now,
  });
  let stored = 0;
  for (const event of events) {
    const body = new TextEncoder().encode(JSON.stringify(event));
    const inserted = await storeDelivery(
      deps,
      {
        eventId: event.id,
        eventType: event.event_type,
        resourceType: event.resource_type,
        resourceId: eventResourceId(event),
      },
      body,
    );
    if (inserted) stored++;
  }
  await deps.kv.set(EVENTS_CURSOR, now.toISOString());
  if (stored > 0) deps.log.info({ stored }, "paypal events polled");
  return stored;
}

async function pollDisputes(deps: ApplyDeps, f: PayPalFetch, now: Date): Promise<void> {
  const updated = await listUpdatedDisputes(
    f,
    (await since(deps, DISPUTES_CURSOR, now)).toISOString(),
  );
  for (const item of updated) await applyDispute(deps, await getDispute(f, item.dispute_id));
  await deps.kv.set(DISPUTES_CURSOR, now.toISOString());
}
