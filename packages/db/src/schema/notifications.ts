import { sql } from "drizzle-orm";
import { char, check, index, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { createdAt } from "./types.ts";

/**
 * A browser's Web Push subscription (W3C Push API): the push service's endpoint and the keys its
 * messages are encrypted to (RFC 8291). Deleted when the push service answers 404 or 410.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: char({ length: 26 }).primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    endpoint: text().notNull().unique("push_subscriptions_endpoint_unique"),
    /** The browser's P-256 public key, base64url. */
    p256dh: text().notNull(),
    /** The browser's 16-byte authentication secret, base64url. */
    auth: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("push_subscriptions_https", sql`${t.endpoint} like 'https://%'`),
    index("push_subscriptions_user_id_idx").on(t.userId),
  ],
);

/**
 * The address a user asked alerts at. Never the login address: mail goes to it only once the
 * user opened the confirmation link sent there.
 */
export const alertEmails = pgTable("alert_emails", {
  userId: text()
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  address: text().notNull(),
  /** The nonce of the one confirmation link that works; cleared once it is used. */
  confirmNonce: text(),
  confirmedAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
});

/** Every email Keelson composed for a user, sent or not: the user's trail of alerts. */
export const sentEmails = pgTable(
  "sent_emails",
  {
    id: char({ length: 26 }).primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    address: text().notNull(),
    /** What it is about, e.g. `purchase.blocked` or `agents.stopped`. */
    event: text().notNull(),
    subject: text().notNull(),
    /** The purchase or stop it reports, when there is one. */
    subjectId: text(),
    logIndex: numeric({ precision: 20, scale: 0, mode: "bigint" }),
    alibiUrl: text(),
    /** The provider's id of the message. */
    providerId: text(),
    /** Null while unsent: no provider is configured, or it refused (`error`). */
    sentAt: timestamp({ withTimezone: true }),
    error: text(),
    createdAt: createdAt(),
  },
  (t) => [index("sent_emails_user_id_created_at_idx").on(t.userId, t.createdAt.desc())],
);
