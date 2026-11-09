import { sql } from "drizzle-orm";
import { bigint, char, check, index, pgTable, text } from "drizzle-orm/pg-core";
import { mandates } from "./mandates.ts";
import { bytea, createdAt, updatedAt } from "./types.ts";

/** One `AUTHORIZE` order per cart, for mandates with `hold_mode = 'per_purchase'`. */
export const purchaseHolds = pgTable(
  "purchase_holds",
  {
    /** The request id the purchase is countersigned under. */
    requestId: char({ length: 26 }).primaryKey(),
    mandateId: char({ length: 26 })
      .notNull()
      .references(() => mandates.id),
    merchantId: text().notNull(),
    currency: char({ length: 3 }).notNull(),
    amountMinor: bigint({ mode: "bigint" }).notNull(),
    cartHash: bytea().notNull(),
    paypalOrderId: text().notNull().unique("purchase_holds_paypal_order_id_unique"),
    paypalAuthorizationId: text().unique("purchase_holds_paypal_authorization_id_unique"),
    state: text({ enum: ["PENDING", "AUTHORIZED", "CAPTURED", "VOIDED"] }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("purchase_holds_amount_positive", sql`${t.amountMinor} > 0`),
    check("purchase_holds_cart_hash_len", sql`octet_length(${t.cartHash}) = 32`),
    check(
      "purchase_holds_state_valid",
      sql`${t.state} in ('PENDING', 'AUTHORIZED', 'CAPTURED', 'VOIDED')`,
    ),
    index("purchase_holds_mandate_id_created_at_idx").on(t.mandateId, t.createdAt.desc()),
  ],
);
