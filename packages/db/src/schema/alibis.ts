import { sql } from "drizzle-orm";
import { char, check, jsonb, pgTable } from "drizzle-orm/pg-core";
import { purchases } from "./purchases.ts";
import { bytea, createdAt } from "./types.ts";

export const alibis = pgTable(
  "alibis",
  {
    purchaseId: char({ length: 26 })
      .primaryKey()
      .references(() => purchases.id),
    leafHash: bytea().notNull().unique("alibis_leaf_hash_unique"),
    bundle: jsonb().notNull(),
    createdAt: createdAt(),
  },
  (t) => [check("alibis_leaf_hash_len", sql`octet_length(${t.leafHash}) = 32`)],
);
