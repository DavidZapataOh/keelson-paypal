import { sql } from "drizzle-orm";
import { bigint, char, check, integer, jsonb, pgTable, smallint, text } from "drizzle-orm/pg-core";
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
    chainId: integer().notNull(),
    /** The EIP-712 `Verdict` message both legs signed, as decimal strings and hex. */
    message: jsonb().$type<Record<string, string>>().notNull(),
    /** Each leg's signature: `{ tee, signer, signature }`. */
    signatures: jsonb().$type<{ tee: number; signer: string; signature: string }[]>().notNull(),
    /** The facts the legs attributed, whose hash is the message's `inputsHash`. */
    facts: jsonb().notNull(),
    txHash: bytea(),
    createdAt: createdAt(),
  },
  (t) => [
    check("verdicts_digest_len", sql`octet_length(${t.digest}) = 32`),
    check("verdicts_tx_hash_len", sql`octet_length(${t.txHash}) = 32`),
  ],
);
