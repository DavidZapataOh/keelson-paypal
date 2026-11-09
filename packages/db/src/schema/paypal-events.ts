import { sql } from "drizzle-orm";
import { char, check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { disputes } from "./disputes.ts";
import { mandates } from "./mandates.ts";
import { purchases } from "./purchases.ts";
import { bytea } from "./types.ts";

/**
 * PayPal webhook events, one row per event id: deliveries verified against PayPal's signature,
 * kept as the exact bytes PayPal sent, and events the poller listed. Received rows are the queue
 * of the worker that re-reads each resource from PayPal and applies what the re-read shows.
 */
export const paypalEvents = pgTable(
  "paypal_events",
  {
    /** PayPal's event id, stable across resends. */
    id: text().primaryKey(),
    eventType: text().notNull(),
    resourceType: text().notNull(),
    resourceId: text().notNull(),
    source: text().notNull(),
    /** Unique per delivery; null for polled events. */
    transmissionId: text().unique("paypal_events_transmission_id_unique"),
    transmissionTime: timestamp({ withTimezone: true }),
    certUrl: text(),
    /** The delivery's `paypal-*` headers. */
    headers: jsonb(),
    body: bytea().notNull(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    status: text().notNull().default("received"),
    /** The authenticated re-read the event was applied from. */
    resource: jsonb(),
    resourceReadAt: timestamp({ withTimezone: true }),
    purchaseId: char({ length: 26 }).references(() => purchases.id),
    mandateId: char({ length: 26 }).references(() => mandates.id),
    disputeId: text().references(() => disputes.id),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp({ withTimezone: true }),
    lastError: text(),
    appliedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check("paypal_events_source_valid", sql`${t.source} in ('webhook', 'poll')`),
    check(
      "paypal_events_status_valid",
      sql`${t.status} in ('received', 'inflight', 'applied', 'ignored', 'mismatch', 'unresolvable', 'failed')`,
    ),
    check(
      "paypal_events_lease_iff_inflight",
      sql`(${t.status} = 'inflight') = (${t.leaseUntil} is not null)`,
    ),
    check(
      "paypal_events_delivery_iff_webhook",
      sql`(${t.source} = 'webhook') = (${t.transmissionId} is not null)`,
    ),
    index("paypal_events_received_next_attempt_at_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'received'`),
    index("paypal_events_inflight_lease_until_idx")
      .on(t.leaseUntil)
      .where(sql`${t.status} = 'inflight'`),
    index("paypal_events_resource_id_idx").on(t.resourceId),
  ],
);
