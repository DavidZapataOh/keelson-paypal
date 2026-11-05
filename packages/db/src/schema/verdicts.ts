import { sql } from "drizzle-orm";
import { bigint, char, check, pgTable, smallint, text } from "drizzle-orm/pg-core";
import { disputes } from "./disputes.ts";
import { bytea, createdAt } from "./types.ts";

export const verdicts = pgTable(
  "verdicts",
  {
    id: char({ length: 26 }).primaryKey(),
    disputeId: text()
      .notNull()
      .unique("verdicts_dispute_id_unique")
      .references(() => disputes.id),
    liable: smallint().notNull(),
    ruleId: smallint().notNull(),
    amountMinor: bigint({ mode: "bigint" }).notNull(),
    currency: char({ length: 3 }).notNull(),
    payee: text().notNull(),
    digest: bytea().notNull().unique("verdicts_digest_unique"),
    txHash: bytea(),
    createdAt: createdAt(),
  },
  (t) => [
    check("verdicts_digest_len", sql`octet_length(${t.digest}) = 32`),
    check("verdicts_tx_hash_len", sql`octet_length(${t.txHash}) = 32`),
  ],
);
