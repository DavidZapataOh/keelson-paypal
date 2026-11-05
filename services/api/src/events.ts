import type { Json } from "@keelson/core";
import { type Db, events, sql } from "@keelson/db";
import type { RedisClientType } from "redis";

/** Channel names: 1 to 128 of A-Z a-z 0-9 : _ -. */
export const CHANNEL = /^[A-Za-z0-9:_-]{1,128}$/;

export const eventsChannel = (channel: string): string => `events:${channel}`;

/**
 * Stores the event, then notifies subscribers with its id once the transaction has committed.
 * A per-channel advisory lock held through commit makes ids on a channel commit in id order,
 * so a subscriber's cursor never skips a row.
 */
export async function publishEvent(
  deps: { db: Db; kv: RedisClientType },
  channel: string,
  subjectId: string,
  payload: Json,
): Promise<bigint> {
  const id = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${channel}))`);
    const [row] = await tx.insert(events).values({ channel, subjectId, payload }).returning({
      id: events.id,
    });
    if (row === undefined) throw new Error("event insert returned no row");
    return row.id;
  });
  await deps.kv.publish(eventsChannel(channel), String(id));
  return id;
}
