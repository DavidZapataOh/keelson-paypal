import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { purchases } from "./purchases.ts";
import { createdAt, updatedAt } from "./types.ts";

/** One leg's signed `CardAuthorization`, as the leg returned it. */
export interface StoredCardVerdict {
  authorization: Record<string, string>;
  chain_id: number;
  digest: string;
  signature: string;
  signer: string;
  tee: number;
}

/**
 * The single-use card a card purchase is paid with, issued after its 2-of-2 ALLOW. Keelson never
 * holds the card number: only the issuer's card token and its last four digits.
 */
export const purchaseCards = pgTable(
  "purchase_cards",
  {
    purchaseId: char({ length: 26 })
      .primaryKey()
      .references(() => purchases.id),
    issuer: text({ enum: ["lithic"] }).notNull(),
    cardToken: text().notNull().unique("purchase_cards_card_token_unique"),
    lastFour: char({ length: 4 }).notNull(),
    /** The issuer-side controls set at issue: spend limit, merchant codes and countries. */
    controls: jsonb().$type<Record<string, unknown>>().notNull(),
    state: text({ enum: ["PAUSED", "OPEN", "USED", "CLOSED"] }).notNull(),
    /** The countersign's `expiresAt`: no authorization passes after it. */
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /** The issuer's transaction of the approved authorization, once there is one. */
    transactionToken: text().unique("purchase_cards_transaction_token_unique"),
    settledMinor: bigint({ mode: "bigint" }),
    settledAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("purchase_cards_last_four", sql`${t.lastFour} ~ '^[0-9]{4}$'`),
    check("purchase_cards_state_valid", sql`${t.state} in ('PAUSED', 'OPEN', 'USED', 'CLOSED')`),
    index("purchase_cards_open_expires_at_idx")
      .on(t.expiresAt)
      .where(sql`${t.state} in ('PAUSED', 'OPEN')`),
  ],
);

/**
 * Each card network authorization of a purchase card, as the issuer's real-time request reported
 * it, and both legs' signed answers. Keyed by the issuer's id of the request, which its retries
 * repeat.
 */
export const cardAuthorizations = pgTable(
  "card_authorizations",
  {
    /** The issuer's id of this authorization request, unique per request. */
    id: text().primaryKey(),
    /** The issuer's transaction the request belongs to, which its settlement names. */
    transactionToken: text().notNull(),
    purchaseId: char({ length: 26 })
      .notNull()
      .references(() => purchases.id),
    amountMinor: bigint({ mode: "bigint" }).notNull(),
    currency: char({ length: 3 }).notNull(),
    mcc: char({ length: 4 }).notNull(),
    merchantName: text().notNull(),
    /** ISO 3166-1 alpha-2, or the issuer's code when it has none. */
    merchantCountry: text().notNull(),
    networkId: text().notNull(),
    approved: boolean().notNull(),
    /** The union of both legs' `failedMask`; a leg that did not answer leaves it 0 and `reason` set. */
    failedMask: integer().notNull(),
    /** Why it was declined before or without both legs' answers. */
    reason: text(),
    tdx: jsonb().$type<StoredCardVerdict>(),
    nitro: jsonb().$type<StoredCardVerdict>(),
    /** From the issuer's request reaching the API to the answer leaving it. */
    latencyMs: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("card_authorizations_mcc", sql`${t.mcc} ~ '^[0-9]{4}$'`),
    check(
      "card_authorizations_approved_signed",
      sql`not ${t.approved} or (${t.tdx} is not null and ${t.nitro} is not null)`,
    ),
    index("card_authorizations_purchase_id_created_at_idx").on(t.purchaseId, t.createdAt),
    // A single-use card approves one authorization.
    uniqueIndex("card_authorizations_one_approved_idx").on(t.purchaseId).where(sql`${t.approved}`),
  ],
);

/**
 * A chargeback the user filed through the card issuer over a card purchase, with the purchase's
 * Alibi as evidence. What it recovered is subtracted from any bond claim over the same purchase.
 */
export const cardChargebacks = pgTable(
  "card_chargebacks",
  {
    /** The issuer's dispute token. */
    id: text().primaryKey(),
    purchaseId: char({ length: 26 })
      .notNull()
      .references(() => purchases.id),
    reason: text({ enum: ["not_received", "not_as_described", "unauthorized"] }).notNull(),
    amountMinor: bigint({ mode: "bigint" }).notNull(),
    /** The issuer's dispute status, e.g. `NEW`, `SUBMITTED`, `CASE_WON` or `CASE_CLOSED`. */
    status: text().notNull(),
    resolution: text(),
    /** What the chargeback returned to the cardholder; known once the case is decided. */
    recoveredMinor: bigint({ mode: "bigint" }),
    evidenceUploaded: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("card_chargebacks_amount_positive", sql`${t.amountMinor} > 0`),
    check(
      "card_chargebacks_reason_valid",
      sql`${t.reason} in ('not_received', 'not_as_described', 'unauthorized')`,
    ),
    // One open chargeback per purchase: the card network takes one at a time.
    uniqueIndex("card_chargebacks_one_open_idx")
      .on(t.purchaseId)
      .where(sql`${t.status} not in ('CASE_WON', 'CASE_CLOSED')`),
  ],
);
