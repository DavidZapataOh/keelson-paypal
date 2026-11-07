import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
} from "drizzle-orm/pg-core";
import { mandates } from "./mandates.ts";
import { bytea, createdAt } from "./types.ts";

/** A sealed capture of what an agent saw; `root` is the `evidenceRoot` a countersign binds. */
export const evidenceBundles = pgTable(
  "evidence_bundles",
  {
    root: bytea().primaryKey(),
    mandateId: char({ length: 26 })
      .notNull()
      .references(() => mandates.id),
    /** The public manifest: type, media type and content hash of every item, no salts. */
    manifest: jsonb().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("evidence_bundles_root_len", sql`octet_length(${t.root}) = 32`),
    index("evidence_bundles_mandate_id_idx").on(t.mandateId),
  ],
);

/** The items of a bundle, with the salts that open them to an arbiter. */
export const evidenceItems = pgTable(
  "evidence_items",
  {
    root: bytea()
      .notNull()
      .references(() => evidenceBundles.root, { onDelete: "cascade" }),
    index: smallint().notNull(),
    type: text().notNull(),
    mediaType: text().notNull(),
    contentHash: bytea().notNull(),
    salt: bytea().notNull(),
    bytes: bytea().notNull(),
  },
  (t) => [
    primaryKey({ name: "evidence_items_root_index_pk", columns: [t.root, t.index] }),
    check("evidence_items_content_hash_len", sql`octet_length(${t.contentHash}) = 32`),
    check("evidence_items_salt_len", sql`octet_length(${t.salt}) = 32`),
  ],
);
