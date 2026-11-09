import { type Db, paypalEvents } from "@keelson/db";
import type { DeliveryHeaders, VerifiedDelivery } from "@keelson/paypal";

/** What the poller knows of an event it listed: no transmission, the event's own bytes. */
export type StoredEvent = Pick<
  VerifiedDelivery,
  "eventId" | "eventType" | "resourceType" | "resourceId"
>;

/**
 * Stores an event once: a second delivery of one transmission, or a resend of one event under a
 * new transmission, inserts nothing. Resolves to `true` when a row was inserted.
 */
export async function storeDelivery(
  deps: { db: Db },
  event: StoredEvent | VerifiedDelivery,
  body: Uint8Array,
  delivery?: DeliveryHeaders,
): Promise<boolean> {
  const transmission =
    delivery && "transmissionTime" in event
      ? {
          source: "webhook",
          transmissionId: event.transmissionId,
          transmissionTime: event.transmissionTime,
          certUrl: delivery.certUrl,
          headers: {
            "paypal-transmission-id": delivery.transmissionId,
            "paypal-transmission-time": delivery.transmissionTime,
            "paypal-transmission-sig": delivery.transmissionSig,
            "paypal-cert-url": delivery.certUrl,
            "paypal-auth-algo": delivery.authAlgo,
          },
        }
      : { source: "poll" };
  const inserted = await deps.db
    .insert(paypalEvents)
    .values({
      id: event.eventId,
      eventType: event.eventType,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      body: Buffer.from(body),
      ...transmission,
    })
    .onConflictDoNothing()
    .returning({ id: paypalEvents.id });
  return inserted.length > 0;
}
