import { bigint, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt } from "./types.js";

export const events = pgTable(
  "events",
  {
    id: bigint({ mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    channel: text().notNull(),
    subjectId: text().notNull(),
    payload: jsonb().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("events_channel_id_idx").on(t.channel, t.id)],
);
