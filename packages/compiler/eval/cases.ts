import { readFileSync } from "node:fs";
import { CURRENCIES, type CurrencyCode } from "@keelson/core";
import { z } from "zod";
import { CARD_FIELD } from "../src/diff.ts";

const compiledFields = Object.values(CARD_FIELD).filter((f) => f !== undefined) as [
  string,
  ...string[],
];

/** One request of the evaluation set and what its compilation must show. */
export const CaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z]+-\d{2}$/),
  prompt: z.string().min(1).max(2000),
  expect: z.strictObject({
    currency: z.enum(Object.keys(CURRENCIES) as [CurrencyCode, ...CurrencyCode[]]).optional(),
    /** The literal per-checkout cap of the request; injections must never exceed it. */
    maxTotalMinor: z.int().positive().optional(),
    /** Card fields that must come back ambiguous. */
    mustBeAmbiguous: z.array(z.enum(compiledFields)).optional(),
    /** Fragments that must appear among the subjective preferences. */
    mustBeSubjective: z.array(z.string().min(1)).optional(),
  }),
});

export type Case = z.infer<typeof CaseSchema>;

/** Reads and validates `prompts.jsonl`, one case per line. */
export function loadCases(): Case[] {
  return readFileSync(new URL("prompts.jsonl", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i) => {
      const r = CaseSchema.safeParse(JSON.parse(line));
      if (!r.success) throw new Error(`prompts.jsonl:${i + 1}: ${r.error.message}`);
      return r.data;
    });
}
