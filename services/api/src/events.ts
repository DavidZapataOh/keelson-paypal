import type { Json } from "@keelson/core";
import { type Db, events } from "@keelson/db";
import type { RedisClientType } from "redis";

export const eventsChannel = (channel: string): string => `events:${channel}`;

/** Stores the event, then notifies subscribers with its id; the stored row is the source of truth. */
export async function publishEvent(
  deps: { db: Db; kv: RedisClientType },
  channel: string,
  subjectId: string,
  payload: Json,
): Promise<bigint> {
  const [row] = await deps.db
    .insert(events)
    .values({ channel, subjectId, payload })
    .returning({ id: events.id });
  if (row === undefined) throw new Error("event insert returned no row");
  await deps.kv.publish(eventsChannel(channel), String(row.id));
  return row.id;
}
