import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
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
    /**
     * `pyusd` pays the merchant on chain; `paypal` pays Keelson's treasury, which sends the
     * merchant a PayPal Payout; `card` pays Keelson's treasury, which sends the user of a card
     * purchase a PayPal Payout of what the card network did not return.
     */
    rail: text().notNull().default("pyusd"),
    /** The buyer's refund under the verdict's `ksv1.` reference. */
    refundId: text(),
    /** The relayed `slash`, `payWarranty` or `executeSlash` that last moved the settlement. */
    txId: char({ length: 26 }),
    txHash: bytea(),
    /** `txId` once its block is final: a refund or payout after a chain payment waits for it. */
    finalTxId: char({ length: 26 }),
    /** `paid`, `queued` (behind the veto window), `claimable` (the transfer failed) or `failed`. */
    outcome: text(),
    /** The contract error that ended a `failed` settlement. */
    failure: text(),
    /**
     * Who pays the payee: `chain` (the bond or the reserve), `violation-pool` (the operator's
     * `ViolationBondPool` deposit, on a court's conviction) or `treasury` (Keelson's own funds, once
     * the chain refused); `treasury` is set before it pays, and `outcome` turns `paid` once it has.
     */
    paidBy: text(),
    /** When a queued slash can be executed. */
    readyAt: timestamp({ withTimezone: true }),
    payoutBatchId: text(),
    /** The payout item's PayPal `transaction_status`. */
    payoutStatus: text(),
    settledAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check("verdicts_digest_len", sql`octet_length(${t.digest}) = 32`),
    check("verdicts_tx_hash_len", sql`octet_length(${t.txHash}) = 32`),
    check("verdicts_rail_valid", sql`${t.rail} in ('pyusd', 'paypal', 'card')`),
    check("verdicts_outcome_valid", sql`${t.outcome} in ('paid', 'queued', 'claimable', 'failed')`),
    check("verdicts_paid_by_valid", sql`${t.paidBy} in ('chain', 'treasury', 'violation-pool')`),
  ],
);
