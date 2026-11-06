import { CURRENCIES, type CurrencyCode } from "@keelson/core";
import { CATEGORY_TABLE, type FieldId } from "@keelson/mandate";
import { z } from "zod";

/**
 * What a model may fill from a request: a strict subset of the mandate. Identity, keys, consent
 * and the commitment come from the system, never from a model.
 */
export const DraftSchema = z.strictObject({
  currency: z.enum(Object.keys(CURRENCIES) as [CurrencyCode, ...CurrencyCode[]]),
  maxTotalMinor: z.int().positive().describe("Cap on one checkout, in minor units"),
  budgetMinor: z.int().positive().describe("Cap on all checkouts together, in minor units"),
  merchants: z.array(z.string()).describe("Merchant names or domains the request names"),
  category: z.array(z.enum(CATEGORY_TABLE.ids as [string, ...string[]])),
  attributes: z.strictObject({
    size_us: z.string().optional(),
    color: z.string().optional().describe('"any" when the request leaves it open'),
  }),
  returns: z.strictObject({ minDays: z.int().nonnegative(), free: z.boolean() }).nullable(),
  notAfter: z.iso.datetime({ offset: true }),
  quantityPerLine: z.int().positive(),
  item: z.string().min(1).describe("Short description of the item wanted"),
  subjective: z
    .array(z.string())
    .describe("Verbatim fragments of the request that no rule can check"),
  summary: z.string(),
});

export type Draft = z.infer<typeof DraftSchema>;

/** A draft field. */
export type DraftField = keyof Draft;

export const DRAFT_FIELDS = Object.keys(DraftSchema.shape) as DraftField[];

export type CompileErrorCode = "both_failed" | "no_merchant" | "no_category" | "deadline_passed";

/** A request that cannot become a mandate; `ambiguous` names the card fields to ask about. */
export class CompileError extends Error {
  readonly code: CompileErrorCode;
  readonly ambiguous: readonly FieldId[];

  constructor(code: CompileErrorCode, ambiguous: readonly FieldId[] = []) {
    super(code);
    this.name = "CompileError";
    this.code = code;
    this.ambiguous = ambiguous;
  }
}
