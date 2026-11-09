import { sql } from "drizzle-orm";
import { char, check, jsonb, pgTable } from "drizzle-orm/pg-core";
import { purchases } from "./purchases.ts";
import { bytea, createdAt, updatedAt } from "./types.ts";

export const alibis = pgTable(
  "alibis",
  {
    purchaseId: char({ length: 26 })
      .primaryKey()
      .references(() => purchases.id),
    leafHash: bytea().notNull().unique("alibis_leaf_hash_unique"),
    /** The immutable core of the bundle, as issued when its leaf was logged. */
    bundle: jsonb().notNull(),
    /** The bundle's `anchor` section, set once an on-chain anchor covers the leaf. */
    anchor: jsonb(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("alibis_leaf_hash_len", sql`octet_length(${t.leafHash}) = 32`)],
);
