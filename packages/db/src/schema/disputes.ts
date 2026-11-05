import { sql } from "drizzle-orm";
import { char, check, index, jsonb, pgTable, smallint, text } from "drizzle-orm/pg-core";
import { disputeState } from "./enums.js";
import { purchases } from "./purchases.js";
import { createdAt, updatedAt } from "./types.js";

export const disputes = pgTable(
  "disputes",
  {
    id: text().primaryKey(),
    purchaseId: char({ length: 26 })
      .notNull()
      .references(() => purchases.id),
    state: disputeState().notNull().default("OPEN"),
    reason: text().notNull(),
    ruleId: smallint(),
    liable: smallint(),
    raw: jsonb().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("disputes_liable_valid", sql`${t.liable} in (1, 2, 3, 4)`),
    index("disputes_purchase_id_idx").on(t.purchaseId),
  ],
);
