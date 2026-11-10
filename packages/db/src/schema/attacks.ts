import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { attackOutcome } from "./enums.ts";
import { purchases } from "./purchases.ts";
import { bytea, createdAt } from "./types.ts";

/**
 * A red-team campaign's ledger ends: its header line, and once it finishes, its summary line and
 * the hash of that last line. The attack lines between them are `attacks` rows.
 */
export const redTeamCampaigns = pgTable(
  "red_team_campaigns",
  {
    id: text().primaryKey(),
    header: text().notNull(),
    summary: text(),
    head: bytea(),
    createdAt: createdAt(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [check("red_team_campaigns_head_len", sql`octet_length(${t.head}) = 32`)],
);

export const attacks = pgTable(
  "attacks",
  {
    id: char({ length: 26 }).primaryKey(),
    campaign: text()
      .notNull()
      .references(() => redTeamCampaigns.id),
    /** The line's place in the campaign's ledger, from 0. */
    seq: integer().notNull(),
    backbone: text().notNull(),
    payloadHash: bytea().notNull(),
    outcome: attackOutcome().notNull(),
    purchaseId: char({ length: 26 }).references(() => purchases.id),
    /** The attack's ledger line, byte for byte, and its chained hash. */
    line: text().notNull(),
    hash: bytea().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("attacks_payload_hash_len", sql`octet_length(${t.payloadHash}) = 32`),
    check("attacks_hash_len", sql`octet_length(${t.hash}) = 32`),
    uniqueIndex("attacks_campaign_seq_idx").on(t.campaign, t.seq),
    index("attacks_created_at_idx").on(t.createdAt.desc()),
  ],
);
