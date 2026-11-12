import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { mandateState } from "./enums.ts";
import { operators } from "./operators.ts";
import { bytea, createdAt, updatedAt } from "./types.ts";

export const mandates = pgTable(
  "mandates",
  {
    id: char({ length: 26 }).primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id),
    operatorAgentId: numeric({ precision: 78, scale: 0, mode: "bigint" })
      .notNull()
      .references(() => operators.agentId),
    state: mandateState().notNull().default("DRAFT"),
    currency: char({ length: 3 }).notNull(),
    maxMinor: bigint({ mode: "bigint" }).notNull(),
    remainingMinor: bigint({ mode: "bigint" }).notNull(),
    merchantIds: text().array().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    mandateHash: bytea().unique("mandates_mandate_hash_unique"),
    commitment: bytea(),
    /** The SD-JWT payload with its `_sd` digests, as signed. */
    payloadSd: jsonb(),
    disclosures: jsonb().$type<string[]>(),
    /** The salts of the payload's decoy digests (RFC 9901 section 4.2.5); empty without decoys. */
    decoySalts: jsonb().$type<string[]>().notNull().default([]),
    /** The mandate's index in the status list, drawn at random and never reused. */
    statusIdx: integer().unique("mandates_status_idx_unique"),
    /** The RFC 7638 thumbprint (hex) of the credential issuer key leg A issued the mandate with. */
    issuerThumbprint: text(),
    /** The WebAuthn assertion over `mandate_hash`. */
    userAuth: jsonb(),
    credentialId: text(),
    /** The open mandate (L2) the TEE issued for the agent to close. */
    openMandate: text(),
    /** The commitment salt, sealed by the TEE to the user and this mandate. */
    sealedSalt: bytea(),
    /**
     * The C3 `anonymous_mandate` proof: UltraHonk for the EVM over `C_m, mandate_hash,
     * user_set_root, rp_id_hash`, and the proof of the same witness for recursion. A registered
     * user signed this mandate; the proof names no user.
     */
    c3Proof: jsonb().$type<{
      proof: string;
      public_inputs: string[];
      recursive_proof?: string | undefined;
    }>(),
    paypalOrderId: text().unique("mandates_paypal_order_id_unique"),
    /** The authorization captures use: the parent, or its reauthorization. */
    paypalAuthorizationId: text().unique("mandates_paypal_authorization_id_unique"),
    /** `mandate`: one hold for the budget; `per_purchase`: one hold per cart. */
    /** `card` when the mandate's purchases are paid with single-use cards. */
    rail: text({ enum: ["paypal", "card"] })
      .notNull()
      .default("paypal"),
    holdMode: text({ enum: ["mandate", "per_purchase"] })
      .notNull()
      .default("mandate"),
    /** The original authorization; a void must target it, never a reauthorization. */
    paypalParentAuthorizationId: text().unique("mandates_paypal_parent_authorization_id_unique"),
    /** The saved PayPal the hold was authorized with, when it was not approved in a PayPal popup. */
    paypalVaultId: text(),
    /** The parent authorization's `create_time`. */
    authorizedAt: timestamp({ withTimezone: true }),
    reauthorizedAt: timestamp({ withTimezone: true }),
    /** The PayPal issue of the last refused reauthorization or void. */
    holdError: text(),
    voidedAt: timestamp({ withTimezone: true }),
    /** Set on revocation; no countersign is issued after it. */
    revokeRequestedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("mandates_remaining_within_max", sql`${t.remainingMinor} between 0 and ${t.maxMinor}`),
    check("mandates_mandate_hash_len", sql`octet_length(${t.mandateHash}) = 32`),
    check("mandates_commitment_len", sql`octet_length(${t.commitment}) = 32`),
    check("mandates_hold_mode_valid", sql`${t.holdMode} in ('mandate', 'per_purchase')`),
    check("mandates_rail_valid", sql`${t.rail} in ('paypal', 'card')`),
    index("mandates_user_id_created_at_idx").on(t.userId, t.createdAt.desc(), t.id.desc()),
    index("mandates_operator_agent_id_idx").on(t.operatorAgentId),
  ],
);
