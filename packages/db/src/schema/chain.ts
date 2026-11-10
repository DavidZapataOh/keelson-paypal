import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bytea, createdAt, updatedAt } from "./types.ts";

export const chainTxStatus = pgEnum("chain_tx_status", [
  "simulating",
  "pending",
  "confirmed",
  "reverted",
  "dropped",
  "rejected",
]);

/** The next nonce each relayer address uses on each chain; one atomic update allocates it. */
export const relayerNonces = pgTable(
  "relayer_nonces",
  {
    chainId: integer().notNull(),
    address: bytea().notNull(),
    next: bigint({ mode: "bigint" }).notNull(),
  },
  (t) => [
    primaryKey({ name: "relayer_nonces_pk", columns: [t.chainId, t.address] }),
    check("relayer_nonces_address_len", sql`octet_length(${t.address}) = 20`),
  ],
);

/** Every call the relayer sends, under the idempotency key that names it. */
export const chainTxs = pgTable(
  "chain_txs",
  {
    id: char({ length: 26 }).primaryKey(),
    chainId: integer().notNull(),
    key: text().notNull(),
    contract: text().notNull(),
    function: text().notNull(),
    sender: bytea().notNull(),
    to: bytea().notNull(),
    data: bytea().notNull(),
    dataHash: bytea().notNull(),
    nonce: bigint({ mode: "bigint" }),
    hash: bytea(),
    raw: bytea(),
    status: chainTxStatus().notNull(),
    errorCode: text(),
    error: jsonb(),
    gasLimit: bigint({ mode: "bigint" }),
    gasUsed: bigint({ mode: "bigint" }),
    effectiveGasPrice: numeric({ precision: 78, scale: 0, mode: "bigint" }),
    blockNumber: bigint({ mode: "bigint" }),
    blockHash: bytea(),
    submittedAt: timestamp({ withTimezone: true }),
    confirmedAt: timestamp({ withTimezone: true }),
    latencyMs: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("chain_txs_chain_id_key_unique").on(t.chainId, t.key),
    uniqueIndex("chain_txs_sender_nonce_uidx")
      .on(t.chainId, t.sender, t.nonce)
      .where(sql`${t.status} in ('pending', 'confirmed', 'reverted')`),
    index("chain_txs_pending_idx").on(t.updatedAt).where(sql`${t.status} = 'pending'`),
    check("chain_txs_data_hash_len", sql`octet_length(${t.dataHash}) = 32`),
    check("chain_txs_sender_len", sql`octet_length(${t.sender}) = 20`),
  ],
);

/**
 * The vault's and the anchor's events Keelson acts on, one row per log. A live subscription
 * inserts them as they are sequenced; the reconciler re-reads every block up to `finalized`,
 * deletes what a reorg removed and marks the rest final.
 */
export const chainEvents = pgTable(
  "chain_events",
  {
    chainId: integer().notNull(),
    txHash: bytea().notNull(),
    logIndex: integer().notNull(),
    blockNumber: bigint({ mode: "bigint" }).notNull(),
    blockHash: bytea().notNull(),
    address: bytea().notNull(),
    name: text().notNull(),
    /** The decoded arguments; integers as decimal strings. */
    args: jsonb().$type<Record<string, string | boolean>>().notNull(),
    finalized: boolean().notNull().default(false),
    /** When the consumer of the event finished with it. */
    handledAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "chain_events_pk", columns: [t.chainId, t.txHash, t.logIndex] }),
    index("chain_events_coverage_idx").on(t.chainId, t.name, sql`(${t.args}->>'coverageId')`),
    index("chain_events_block_idx").on(t.chainId, t.blockNumber),
    index("chain_events_unhandled_idx").on(t.chainId, t.name).where(sql`${t.handledAt} is null`),
    check("chain_events_tx_hash_len", sql`octet_length(${t.txHash}) = 32`),
  ],
);

/** The last block of each chain whose events are all in `chain_events` and final. */
export const chainCursors = pgTable("chain_cursors", {
  chainId: integer().primaryKey(),
  block: bigint({ mode: "bigint" }).notNull(),
  updatedAt: updatedAt(),
});
