import { sql } from "drizzle-orm";
import { check, integer, jsonb, numeric, pgTable, text, unique } from "drizzle-orm/pg-core";
import { bytea, createdAt } from "./types.ts";

export const operators = pgTable(
  "operators",
  {
    agentId: numeric({ precision: 78, scale: 0, mode: "bigint" }).primaryKey(),
    chainId: integer().notNull(),
    /** The ERC-8004 Identity registry of the agent, `eip155:<chain_id>:<identity>`. */
    agentRegistry: text().notNull(),
    name: text().notNull(),
    cnfJwk: jsonb().notNull(),
    /** The agent's owner in the Identity registry when it was linked. */
    ownerAddress: bytea(),
    /** The OAuth client that linked the operator: the only client that acts for the agent. */
    clientId: text(),
    /** SHA-256 of the last `OperatorLink` message accepted; each one links at most once. */
    linkDigest: bytea(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("operators_agent_registry_agent_id_unique").on(t.agentRegistry, t.agentId),
    check(
      "operators_agent_registry_chain",
      sql`${t.agentRegistry} like 'eip155:' || ${t.chainId} || ':0x%'`,
    ),
    check("operators_owner_address_len", sql`octet_length(${t.ownerAddress}) = 20`),
  ],
);
