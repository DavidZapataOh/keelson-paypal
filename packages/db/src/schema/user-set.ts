import { sql } from "drizzle-orm";
import { check, integer, pgTable } from "drizzle-orm/pg-core";
import { bytea, createdAt } from "./types.ts";

/**
 * Every root the registered-user tree has had: a C3 proof names one, and a verifier accepts a root
 * listed here. Leaves are the passkeys' `user_key_hash` in registration order.
 */
export const userSetRoots = pgTable(
  "user_set_roots",
  {
    root: bytea().primaryKey(),
    /** Users in the tree when it had this root. */
    size: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("user_set_roots_root_len", sql`octet_length(${t.root}) = 32`),
    check("user_set_roots_size_positive", sql`${t.size} > 0`),
  ],
);
