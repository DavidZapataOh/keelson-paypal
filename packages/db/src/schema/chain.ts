import { sql } from "drizzle-orm";
import {
  bigint,
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
