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
    lastError: text(),
    latencyMs: integer(),
    createdAt: createdAt(),
    stampedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: "timestamps_hash_tsa_pk", columns: [t.hash, t.tsa] }),
    check("timestamps_hash_len", sql`octet_length(${t.hash}) = 32`),
    check("timestamps_kind_valid", sql`${t.kind} in ('leaf', 'channel3')`),
    check("timestamps_role_valid", sql`${t.role} in ('primary', 'fallback')`),
    check("timestamps_status_valid", sql`${t.status} in ('pending', 'stamped', 'failed')`),
    check(
      "timestamps_token_iff_stamped",
      sql`(${t.status} = 'stamped') = (${t.token} is not null)`,
    ),
    index("timestamps_pending_created_at_idx").on(t.createdAt).where(sql`${t.status} = 'pending'`),
  ],
);
