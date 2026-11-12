import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** The latest token leg A signed for each status list (draft-ietf-oauth-status-list-21). */
export const statusLists = pgTable("status_lists", {
  uri: text().primaryKey(),
  /** The `statuslist+jwt` token. */
  token: text().notNull(),
  /** Its `iat`. */
  signedAt: timestamp({ withTimezone: true }).notNull(),
});
