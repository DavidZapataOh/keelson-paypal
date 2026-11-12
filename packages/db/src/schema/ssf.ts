import { char, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { createdAt } from "./types.ts";

/**
 * An OpenID Shared Signals stream (SSF 1.0): an OAuth client acting for a user, told by poll
 * (RFC 8936) of the security events about that user.
 */
export const ssfStreams = pgTable(
  "ssf_streams",
  {
    id: char({ length: 26 }).primaryKey(),
    clientId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** `enabled`, `paused` or `disabled` (SSF §8.1.2). */
    status: text({ enum: ["enabled", "paused", "disabled"] })
      .notNull()
      .default("enabled"),
    createdAt: createdAt(),
  },
  // One stream per receiver and user (SSF §8.1.1.1: a second create answers 409).
  (t) => [uniqueIndex("ssf_streams_client_id_user_id_idx").on(t.clientId, t.userId)],
);

/** A Security Event Token (RFC 8417) queued for a stream until its receiver acknowledges it. */
export const ssfEvents = pgTable(
  "ssf_events",
  {
    jti: char({ length: 26 }).primaryKey(),
    streamId: char({ length: 26 })
      .notNull()
      .references(() => ssfStreams.id, { onDelete: "cascade" }),
    set: text().notNull(),
    createdAt: createdAt(),
    ackedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index("ssf_events_pending_idx").on(t.streamId, t.createdAt)],
);
