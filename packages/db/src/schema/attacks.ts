import { sql } from "drizzle-orm";
import { char, check, index, pgTable, text } from "drizzle-orm/pg-core";
import { attackOutcome } from "./enums.js";
import { purchases } from "./purchases.js";
import { bytea, createdAt } from "./types.js";

export const attacks = pgTable(
  "attacks",
  {
    id: char({ length: 26 }).primaryKey(),
    campaign: text().notNull(),
    backbone: text().notNull(),
    payloadHash: bytea().notNull(),
    outcome: attackOutcome().notNull(),
    purchaseId: char({ length: 26 }).references(() => purchases.id),
    createdAt: createdAt(),
  },
  (t) => [
    check("attacks_payload_hash_len", sql`octet_length(${t.payloadHash}) = 32`),
    index("attacks_created_at_idx").on(t.createdAt.desc()),
  ],
);
