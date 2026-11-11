import { sql } from "drizzle-orm";
import { char, check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { bytea, createdAt } from "./types.ts";

/**
 * A user stopped every agent at once: from `createdAt`, no mandate of theirs stored before it is
 * countersigned. Its mandates are revoked and their holds released, and once no purchase of them
 * can still be logged, a `keelson.finance/stop/v1` leaf commits to them in the Alibi log.
 */
export const agentStops = pgTable(
  "agent_stops",
  {
    id: char({ length: 26 }).primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The hex of the 32-byte hashes of the mandates the stop ended. */
    mandateHashes: text().array().notNull().default(sql`'{}'`),
    revoked: integer().notNull().default(0),
    /** What PayPal released when the stop voided the holds, per currency in minor units. */
    released: jsonb().$type<{ currency: string; minor: string }[]>().notNull().default([]),
    /** Holds still backing a countersigned purchase: released once it is captured. */
    releasing: jsonb().$type<{ currency: string; minor: string }[]>().notNull().default([]),
    /** The stop leaf, once the stop knows its mandates; none when it ended none. */
    leaf: bytea(),
    /** The leaf's index in each log origin it was appended to. */
    logIndexes: jsonb().$type<Record<string, string>>().notNull().default({}),
    /** When every origin that needs the leaf has it; until then the resumer keeps trying. */
    loggedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check("agent_stops_revoked_nonnegative", sql`${t.revoked} >= 0`),
    index("agent_stops_user_id_created_at_idx").on(t.userId, t.createdAt.desc()),
    index("agent_stops_unlogged_idx").on(t.createdAt).where(sql`${t.loggedAt} is null`),
  ],
);
