import { sql } from "drizzle-orm";
import { char, check, jsonb, pgTable, text, unique } from "drizzle-orm/pg-core";
import { disputes } from "./disputes.ts";
import { createdAt } from "./types.ts";

/** What Keelson sent PayPal for a dispute: one row per action and request from PayPal. */
export const disputeResponses = pgTable(
  "dispute_responses",
  {
    id: char({ length: 26 }).primaryKey(),
    disputeId: text()
      .notNull()
      .references(() => disputes.id),
    /** `provide_evidence`, `send_message` or `accept_claim`. */
    action: text().notNull(),
    /** PayPal's `dispute_life_cycle_stage` when it was sent. */
    stage: text().notNull(),
    /** PayPal's `seller_response_due_date` it answered; each new request sets a new one. */
    dueDate: text().notNull(),
    /** The request body's `input` part, as sent. */
    input: jsonb().notNull(),
    /** The drafted statement, its citations, and whether a model or the fixed text wrote it. */
    draft: jsonb(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("dispute_responses_once").on(t.disputeId, t.action, t.stage, t.dueDate),
    check(
      "dispute_responses_action_valid",
      sql`${t.action} in ('provide_evidence', 'send_message', 'accept_claim')`,
    ),
  ],
);
