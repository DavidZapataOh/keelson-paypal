import type { Json } from "@keelson/core";
import { type Db, eq, mandates, purchases } from "@keelson/db";
import type { RedisClientType } from "redis";
import { publishEvent } from "../events.ts";
import { principalChannel } from "../principal.ts";

/**
 * Publishes a purchase event on `purchase:<id>` of the mandate's owner and of the client that
 * asked for the countersign, and with its `mandateId` on the owner's `mandate:<id>`, so the app
 * follows every purchase of a mandate on one stream.
 */
export async function publishPurchase(
  deps: { db: Db; kv: RedisClientType },
  purchaseId: string,
  payload: { type: `purchase.${string}` } & Record<string, Json>,
): Promise<void> {
  const [row] = await deps.db
    .select({ userId: mandates.userId, mandateId: mandates.id, clientId: purchases.clientId })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .where(eq(purchases.id, purchaseId));
  if (!row) return;
  const suffix = `purchase:${purchaseId}`;
  const event = { ...payload, purchaseId };
  await publishEvent(
    deps,
    principalChannel({ kind: "user", subject: row.userId }, suffix),
    purchaseId,
    event,
  );
  await publishEvent(
    deps,
    principalChannel({ kind: "user", subject: row.userId }, `mandate:${row.mandateId}`),
    purchaseId,
    { ...event, mandateId: row.mandateId },
  );
  if (row.clientId) {
    await publishEvent(
      deps,
      principalChannel({ kind: "client", subject: row.clientId }, suffix),
      purchaseId,
      event,
    );
  }
}
