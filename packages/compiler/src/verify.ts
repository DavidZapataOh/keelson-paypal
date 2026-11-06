import type { Card, FieldId } from "@keelson/mandate";
import { z } from "zod";

/** What the round-trip check reports: card rows that do not say what the request says. */
export const CheckSchema = z.strictObject({
  discrepancies: z.array(z.strictObject({ field: z.string(), issue: z.string() })),
});

export type Discrepancy = z.infer<typeof CheckSchema>["discrepancies"][number];

/** The card fields a model writes; the rest come from the system and are not checked. */
const COMPILED: ReadonlySet<FieldId> = new Set([
  "total",
  "currency",
  "budget",
  "merchant",
  "deadline",
  "quantity",
  "items",
  "category",
  "variant",
  "return_policy",
  "subjective",
  "summary",
]);

/** The compiled rows of a card as plain text, one row per line, ambiguous rows marked. */
export function cardText(card: Card, ambiguous: readonly FieldId[]): string {
  return card.rows
    .filter((r) => COMPILED.has(r.field))
    .map(
      (r) =>
        `${r.label}${ambiguous.includes(r.field) ? " (unsettled)" : ""}: ${r.values.join("; ")}`,
    )
    .join("\n");
}
