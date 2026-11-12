import { pgTable, text } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { createdAt } from "./types.ts";

/**
 * The PayPal a user saved for Keelson's holds: a PayPal Vault payment token, one per user. Holds
 * under the user's mandates are authorized with it, with no PayPal login.
 */
export const paypalWallets = pgTable("paypal_wallets", {
  userId: text()
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** The payment token's id: the `vault_id` of the holds. Never leaves the API. */
  vaultId: text().notNull().unique("paypal_wallets_vault_id_unique"),
  /** PayPal's customer id, passed when the user saves PayPal again. */
  customerId: text().notNull(),
  /** The PayPal account's email, as PayPal returned it, to show the user. */
  email: text(),
  createdAt: createdAt(),
});
