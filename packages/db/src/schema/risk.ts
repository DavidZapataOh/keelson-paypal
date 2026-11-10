import { char, index, jsonb, pgTable } from "drizzle-orm/pg-core";
import { createdAt } from "./types.ts";

/** A calibration of the risk model: its prior from the red team and its recorded loss ratios. */
export const riskCalibrations = pgTable(
  "risk_calibrations",
  {
    id: char({ length: 26 }).primaryKey(),
    body: jsonb().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("risk_calibrations_created_at_idx").on(t.createdAt.desc())],
);
