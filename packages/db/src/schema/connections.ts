import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { oauthClient, user } from "./auth.ts";
import { mandates } from "./mandates.ts";
import { operators } from "./operators.ts";
import { bytea, createdAt } from "./types.ts";

/**
 * An agent's request for a mandate, which the user approves or denies on Keelson's page with the
 * user code (RFC 8628 device authorization semantics). `connect` asks for standing limits;
 * `once` asks to buy exactly one cart its mandate does not allow.
 */
export const agentConnections = pgTable(
  "agent_connections",
  {
    id: char({ length: 26 }).primaryKey(),
    kind: text({ enum: ["connect", "once"] }).notNull(),
    /** The OAuth client that asked; only it may poll the request. */
    clientId: text().notNull(),
    operatorAgentId: numeric({ precision: 78, scale: 0, mode: "bigint" })
      .notNull()
      .references(() => operators.agentId),
    /** The agent's name as it presents itself, e.g. `Claude Code`. */
    name: text().notNull(),
    /** Why it asks, in its own words; shown to the user verbatim. */
    reason: text().notNull(),
    /** `XXXX-XXXX` from RFC 8628's base-20 alphabet. */
    userCode: char({ length: 9 }).notNull().unique("agent_connections_user_code_unique"),
    /** SHA-256 of the device code; the code itself is only ever sent to the agent. */
    deviceCodeHash: bytea().notNull().unique("agent_connections_device_code_hash_unique"),
    currency: char({ length: 3 }).notNull(),
    perPurchaseMinor: bigint({ mode: "bigint" }).notNull(),
    totalMinor: bigint({ mode: "bigint" }).notNull(),
    /** Above this a cart needs the user's one-time approval, though the mandate allows it. */
    askAboveMinor: bigint({ mode: "bigint" }),
    merchantIds: text().array().notNull(),
    notAfter: timestamp({ withTimezone: true }).notNull(),
    /** For `once`: the mandate the cart fell outside of, and the cart. */
    parentMandateId: char({ length: 26 }).references(() => mandates.id),
    cartHash: bytea(),
    state: text({ enum: ["PENDING", "APPROVED", "DENIED"] })
      .notNull()
      .default("PENDING"),
    /** Who decided; for `once`, the parent mandate's user from the start. */
    userId: text().references(() => user.id, { onDelete: "cascade" }),
    /** The mandate the user signed to approve. */
    mandateId: char({ length: 26 }).references(() => mandates.id),
    /** Seconds the agent waits between polls; raised by 5 on each `slow_down`. */
    pollInterval: integer().notNull().default(5),
    polledAt: timestamp({ withTimezone: true }),
    /** When the agent read the approval; the device code is spent then. */
    redeemedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    decidedAt: timestamp({ withTimezone: true }),
    disconnectedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check("agent_connections_kind_valid", sql`${t.kind} in ('connect', 'once')`),
    check("agent_connections_state_valid", sql`${t.state} in ('PENDING', 'APPROVED', 'DENIED')`),
    check(
      "agent_connections_limits",
      sql`${t.perPurchaseMinor} > 0 and ${t.perPurchaseMinor} <= ${t.totalMinor} and (${t.askAboveMinor} is null or ${t.askAboveMinor} between 1 and ${t.perPurchaseMinor})`,
    ),
    check(
      "agent_connections_approved",
      sql`${t.state} <> 'APPROVED' or (${t.mandateId} is not null and ${t.userId} is not null)`,
    ),
    check(
      "agent_connections_once",
      sql`${t.kind} <> 'once' or (${t.parentMandateId} is not null and ${t.userId} is not null and octet_length(${t.cartHash}) = 32)`,
    ),
    index("agent_connections_user_id_operator_idx").on(t.userId, t.operatorAgentId),
    index("agent_connections_mandate_id_idx").on(t.mandateId),
  ],
);

/**
 * The origins an OAuth client's agent platform may frame Keelson's approval in: each is the
 * `frame-ancestors` of the embed page for the requests that client makes.
 */
export const embedOrigins = pgTable(
  "embed_origins",
  {
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    /** A serialized https origin: scheme, host and port only. */
    origin: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.clientId, t.origin] }),
    check(
      "embed_origins_https",
      sql`${t.origin} ~ '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9](:[0-9]{1,5})?$'`,
    ),
  ],
);
