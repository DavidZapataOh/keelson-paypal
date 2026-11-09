import { sql } from "drizzle-orm";
import { check, numeric, pgTable, text } from "drizzle-orm/pg-core";
import { updatedAt } from "./types.ts";

/** How a merchant is paid when a verdict makes the operator or Keelson pay: PYUSD on chain or a PayPal Payout. */
export const merchantSettlement = pgTable(
  "merchant_settlement",
  {
    merchantId: text().primaryKey(),
    rail: text().notNull(),
    /** The PayPal account a `paypal` rail pays: an email address or a PayPal account id. */
    paypalReceiver: text(),
    /** The nonce of the merchant's signature over this choice; a new choice needs a higher one. */
    nonce: numeric({ precision: 78, scale: 0 }).notNull().default("0"),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("merchant_settlement_rail_valid", sql`${t.rail} in ('pyusd', 'paypal')`),
    check(
      "merchant_settlement_receiver",
      sql`${t.rail} = 'pyusd' or ${t.paypalReceiver} is not null`,
    ),
  ],
);
