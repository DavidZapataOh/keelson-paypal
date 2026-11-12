import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { bytea, createdAt } from "./types.ts";

/** RFC 3161 tokens over a hash, one row per TSA asked; pending rows are the stamping queue. */
export const timestamps = pgTable(
  "timestamps",
  {
    hash: bytea().notNull(),
    kind: text().notNull(),
    tsa: text().notNull(),
    role: text().notNull(),
    status: text().notNull().default("pending"),
    /** DER `TimeStampToken`. */
    token: bytea(),
    genTime: timestamp({ withTimezone: true }),
    serial: text(),
    /** Worker rounds tried, each with its own retries. */
    attempts: integer().notNull().default(0),
    /** A pending row is not claimed before this: a retry's backoff or a rate limit's wait. */
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** An in-flight row whose lease has passed was lost with its worker and is claimed again. */
    leaseUntil: timestamp({ withTimezone: true }),
    lastError: text(),
    latencyMs: integer(),
    createdAt: createdAt(),
    stampedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: "timestamps_hash_tsa_pk", columns: [t.hash, t.tsa] }),
    check("timestamps_hash_len", sql`octet_length(${t.hash}) = 32`),
    check("timestamps_kind_valid", sql`${t.kind} in ('leaf', 'channel3', 'statement')`),
    check("timestamps_role_valid", sql`${t.role} in ('primary', 'fallback')`),
    check(
      "timestamps_status_valid",
      sql`${t.status} in ('pending', 'inflight', 'stamped', 'failed')`,
    ),
    check(
      "timestamps_lease_iff_inflight",
      sql`(${t.status} = 'inflight') = (${t.leaseUntil} is not null)`,
    ),
    check(
      "timestamps_token_iff_stamped",
      sql`(${t.status} = 'stamped') = (${t.token} is not null)`,
    ),
    index("timestamps_pending_next_attempt_at_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index("timestamps_inflight_lease_until_idx")
      .on(t.leaseUntil)
      .where(sql`${t.status} = 'inflight'`),
  ],
);
