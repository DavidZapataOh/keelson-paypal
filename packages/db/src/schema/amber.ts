import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  timestamp,
} from "drizzle-orm/pg-core";
import { bytea, createdAt } from "./types.ts";

/** The C2b proof a conviction was made with, as the `slashAmber` call to the court carried it. */
export interface StoredC2b {
  /** The proof's size in bytes and its keccak256. */
  bytes: number;
  hash: string;
  public_inputs: string[];
  /** The `WebFact` the proof opened. */
  fact: { host_hash: string; url_path_hash: string; range_commitment: string; t_capture: string };
}

/** `AmberContradictionCourt` convictions, projected from its `AmberContradictionProven` events. */
export const amberConvictions = pgTable(
  "amber_convictions",
  {
    coverageId: bytea().primaryKey(),
    /** The purchase whose id the coverage id holds, when it is a ULID. */
    purchaseId: char({ length: 26 }),
    chainId: integer().notNull(),
    fieldId: smallint().notNull(),
    provenAt: timestamp({ withTimezone: true }).notNull(),
    webFactDigest: bytea().notNull(),
    txHash: bytea().notNull(),
    blockNumber: bigint({ mode: "bigint" }).notNull(),
    proof: jsonb().$type<StoredC2b>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("amber_convictions_purchase_id_idx").on(t.purchaseId),
    check("amber_convictions_coverage_id_len", sql`octet_length(${t.coverageId}) = 32`),
    check("amber_convictions_field_id_range", sql`${t.fieldId} between 1 and 4`),
  ],
);
