import { sql } from "drizzle-orm";
import { char, check, index, integer, jsonb, numeric, pgTable, text } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { bytea, createdAt } from "./types.ts";

/**
 * A user stopped every agent at once: every live mandate revoked, its holds released, every
 * request denied and every agent's OAuth grant revoked. Logged as a `keelson.finance/stop/v1`
 * leaf, so no Alibi of a stopped mandate can appear after it unseen.
 */
export const agentStops = pgTable(
  "agent_stops",
  {
    id: char({ length: 26 }).primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The hex of the 32-byte hashes of the mandates the stop ended, as the leaf commits to them. */
    mandateHashes: text().array().notNull(),
    revoked: integer().notNull(),
    /** What PayPal held for them when the stop began, per currency in minor units. */
    released: jsonb().$type<{ currency: string; minor: string }[]>().notNull(),
    leaf: bytea().notNull(),
    logIndex: numeric({ precision: 20, scale: 0, mode: "bigint" }),
    createdAt: createdAt(),
  },
  (t) => [
    check("agent_stops_revoked_nonnegative", sql`${t.revoked} >= 0`),
    index("agent_stops_user_id_created_at_idx").on(t.userId, t.createdAt.desc()),
  ],
);
