import { pgEnum } from "drizzle-orm/pg-core";

export const mandateState = pgEnum("mandate_state", [
  "DRAFT",
  "COMPILED",
  "SIGNED",
  "HOLD_PENDING",
  "ACTIVE",
  "EXHAUSTED",
  "EXPIRED",
  "REVOKED",
]);

export const purchaseState = pgEnum("purchase_state", [
  "PROPOSED",
  "EVALUATING",
  "DENIED",
  "COUNTERSIGNED",
  "LOGGED",
  "COVERED",
  "CAPTURED",
  "DELIVERED",
  "SETTLED",
  "DISPUTED",
  "ATTRIBUTED",
  "SLASHED",
  "WARRANTY_PAID",
  "DEFENDED",
  "MERCHANT_LIABLE",
  "FAILED",
]);

export const disputeState = pgEnum("dispute_state", ["OPEN", "ATTRIBUTED", "RESOLVED"]);

export const attackOutcome = pgEnum("attack_outcome", ["BLOCKED", "SUCCEEDED", "NO_EFFECT"]);
