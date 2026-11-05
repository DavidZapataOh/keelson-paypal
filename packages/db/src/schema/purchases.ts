import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  char,
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  varchar,
} from "drizzle-orm/pg-core";
import { purchaseState } from "./enums.js";
import { mandates } from "./mandates.js";
import { bytea, createdAt, updatedAt } from "./types.js";

export const openPurchase = (state: AnyPgColumn) =>
  sql`${state} not in ('SETTLED', 'DENIED', 'FAILED', 'SLASHED', 'WARRANTY_PAID', 'DEFENDED', 'MERCHANT_LIABLE')`;

export const purchases = pgTable(
  "purchases",
  {
    id: char({ length: 26 }).primaryKey(),
    mandateId: char({ length: 26 })
      .notNull()
      .references(() => mandates.id),
    state: purchaseState().notNull().default("PROPOSED"),
    failureReason: text(),
    merchantId: text().notNull(),
    currency: char({ length: 3 }).notNull(),
    amountMinor: bigint({ mode: "bigint" }).notNull(),
    cartHash: bytea().notNull(),
    countersignDigest: bytea().unique("purchases_countersign_digest_unique"),
    decision: smallint(),
    failedFieldsMask: integer(),
    invoiceId: varchar({ length: 60 }).unique("purchases_invoice_id_unique"),
    paypalCaptureId: text().unique("purchases_paypal_capture_id_unique"),
    logIndex: bigint({ mode: "bigint" }).unique("purchases_log_index_unique"),
    anchoredSize: bigint({ mode: "bigint" }),
    chainId: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("purchases_amount_positive", sql`${t.amountMinor} > 0`),
    check("purchases_decision_valid", sql`${t.decision} in (1, 2)`),
    check("purchases_cart_hash_len", sql`octet_length(${t.cartHash}) = 32`),
    check("purchases_countersign_digest_len", sql`octet_length(${t.countersignDigest}) = 32`),
    index("purchases_mandate_id_created_at_idx").on(t.mandateId, t.createdAt.desc(), t.id.desc()),
    index("purchases_merchant_id_created_at_idx").on(t.merchantId, t.createdAt.desc()),
    index("purchases_open_created_at_idx").on(t.createdAt, t.id).where(openPurchase(t.state)),
  ],
);
