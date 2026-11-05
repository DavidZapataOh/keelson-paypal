import { integer, jsonb, numeric, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt } from "./types.ts";

export const operators = pgTable("operators", {
  agentId: numeric({ precision: 78, scale: 0, mode: "bigint" }).primaryKey(),
  chainId: integer().notNull(),
  name: text().notNull(),
  cnfJwk: jsonb().notNull(),
  createdAt: createdAt(),
});
