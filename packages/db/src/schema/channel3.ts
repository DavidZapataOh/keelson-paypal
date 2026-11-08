import { sql } from "drizzle-orm";
import { char, check, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { mandates } from "./mandates.ts";
import { purchases } from "./purchases.ts";
import { bytea, createdAt } from "./types.ts";

/**
 * What Channel3 said about a product page at decision time, compared with what the agent saw.
 * `content_hash` is the SHA-256 of the JCS document and is stamped under kind `channel3`.
 */
export const channel3Observations = pgTable(
  "channel3_observations",
  {
    id: char({ length: 26 }).primaryKey(),
    mandateId: char({ length: 26 })
      .notNull()
      .references(() => mandates.id),
    /** Set once a countersign binds the observation; it binds one purchase only. */
    purchaseId: char({ length: 26 })
      .unique()
      .references(() => purchases.id),
    /** The OAuth client that asked for the observation. */
    requestedBy: text().notNull(),
    url: text().notNull(),
    status: text().notNull(),
    document: jsonb().notNull(),
    contentHash: bytea().notNull().unique(),
    salt: bytea().notNull(),
    /** The exact response bytes, kept for an arbiter when they fit. */
    raw: bytea(),
    createdAt: createdAt(),
  },
  (t) => [
    check("channel3_observations_status_valid", sql`${t.status} in ('ok', 'unavailable')`),
    check("channel3_observations_content_hash_len", sql`octet_length(${t.contentHash}) = 32`),
    check("channel3_observations_salt_len", sql`octet_length(${t.salt}) = 32`),
    check("channel3_observations_raw_size", sql`octet_length(${t.raw}) <= 524288`),
    index("channel3_observations_mandate_id_created_at_idx").on(t.mandateId, t.createdAt.desc()),
  ],
);
