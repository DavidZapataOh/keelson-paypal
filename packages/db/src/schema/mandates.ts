import { sql } from "drizzle-orm";
import { bigint, char, check, index, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { mandateState } from "./enums.js";
import { operators } from "./operators.js";
import { bytea, createdAt, updatedAt } from "./types.js";

export const mandates = pgTable(
  "mandates",
  {
    id: char({ length: 26 }).primaryKey(),
    userId: text().notNull(),
    operatorAgentId: numeric({ precision: 78, scale: 0, mode: "bigint" })
      .notNull()
      .references(() => operators.agentId),
    state: mandateState().notNull().default("DRAFT"),
    currency: char({ length: 3 }).notNull(),
    maxMinor: bigint({ mode: "bigint" }).notNull(),
    remainingMinor: bigint({ mode: "bigint" }).notNull(),
    merchantIds: text().array().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    mandateHash: bytea().unique("mandates_mandate_hash_unique"),
    commitment: bytea(),
    paypalOrderId: text().unique("mandates_paypal_order_id_unique"),
    paypalAuthorizationId: text().unique("mandates_paypal_authorization_id_unique"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("mandates_remaining_within_max", sql`${t.remainingMinor} between 0 and ${t.maxMinor}`),
    check("mandates_mandate_hash_len", sql`octet_length(${t.mandateHash}) = 32`),
    check("mandates_commitment_len", sql`octet_length(${t.commitment}) = 32`),
    index("mandates_user_id_created_at_idx").on(t.userId, t.createdAt.desc(), t.id.desc()),
  ],
);
