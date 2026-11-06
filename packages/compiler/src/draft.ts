import { CURRENCIES, type CurrencyCode } from "@keelson/core";
import { CATEGORY_TABLE } from "@keelson/mandate";
import { z } from "zod";

/**
 * What a model may fill from a request: a strict subset of the mandate. Identity, keys, consent
 * and the commitment come from the system, never from a model.
 */
export const DraftSchema = z.strictObject({
  currency: z.enum(Object.keys(CURRENCIES) as [CurrencyCode, ...CurrencyCode[]]),
  maxTotalMinor: z
    .int()
    .positive()
    .nullable()
    .describe("Cap on one checkout, in minor units; null when the request states none"),
  budgetMinor: z.int().positive().describe("Cap on all checkouts together, in minor units"),
  merchants: z.array(z.string()).describe("Merchant names or domains the request names"),
  category: z.array(z.enum(CATEGORY_TABLE.ids as [string, ...string[]])),
  attributes: z.strictObject({
    size_us: z.string().optional(),
    color: z.string().optional().describe('"any" when the request leaves it open'),
  }),
  returns: z.strictObject({ minDays: z.int().nonnegative(), free: z.boolean() }).nullable(),
  notAfter: z.iso
    .datetime({ offset: true })
    .nullable()
    .describe("Deadline; null when the request states none"),
  quantityPerLine: z.int().positive().nullable().describe("null when the request states none"),
  item: z.string().min(1).describe("Short description of the item wanted"),
  subjective: z
    .array(z.string())
    .describe("Verbatim fragments of the request that no rule can check"),
  summary: z.string(),
});

/** A mandate as a compiler model drafts it from a request. */
export type Draft = z.infer<typeof DraftSchema>;

/** A draft field. */
export type DraftField = keyof Draft;

/** The fields of a draft, in schema order. */
export const DRAFT_FIELDS = Object.keys(DraftSchema.shape) as DraftField[];

/** Why a request cannot become a mandate. */
export type CompileErrorCode =
  | "both_failed"
  | "conflict"
  | "needs_input"
  | "invalid_draft"
  | "no_merchant"
  | "no_category"
  | "deadline_passed"
  | "prompt_too_long"
  | "aborted";

/**
 * A request that cannot become a mandate. `fields` names what to ask the user about: draft field
 * paths such as `currency` or `attributes.size_us`, or the mandate path a draft value broke.
 */
export class CompileError extends Error {
  readonly code: CompileErrorCode;
  /** What to ask the user about. */
  readonly fields: readonly string[];

  constructor(code: CompileErrorCode, fields: readonly string[] = []) {
    super(fields.length ? `${code}: ${fields.join(", ")}` : code);
    this.name = "CompileError";
    this.code = code;
    this.fields = fields;
  }
}

/** Validates a draft, throwing `invalid_draft` with the offending paths. */
export function parseDraft(input: unknown): Draft {
  const r = DraftSchema.safeParse(input);
  if (r.success) return r.data;
  throw new CompileError("invalid_draft", unique(r.error.issues.map((i) => i.path.join("."))));
}

const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
