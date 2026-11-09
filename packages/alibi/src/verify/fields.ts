import type { FieldTrace } from "@keelson/policy";
import type { AlibiBundle, AlibiReceipt } from "../schema.ts";
import { isBundle } from "./checks/util.ts";

/** Who answers for a field: Keelson's warranty (green), the operator's bond (amber), the user (grey). */
export type Answers = "Keelson" | "Agent operator" | "User";

/** One policy of the trace: what it compared, whether it held, and who answers for it. */
export interface FieldRow {
  id: string;
  field: string;
  color: "green" | "amber" | "grey";
  pass: boolean;
  observed?: unknown;
  bound?: unknown;
  answers: Answers;
  evidence: string[];
}

const ANSWERS: Record<FieldRow["color"], Answers> = {
  green: "Keelson",
  amber: "Agent operator",
  grey: "User",
};

/** The fields table of an Alibi's `keelson.eval/1` trace; empty for a receipt. */
export function fieldsOf(input: AlibiBundle | AlibiReceipt): FieldRow[] {
  if (!isBundle(input)) return [];
  return (input.eval.fields as unknown as FieldTrace[]).flatMap((f) => {
    const color = f.color as FieldRow["color"];
    if (!Object.hasOwn(ANSWERS, color)) return [];
    const row: FieldRow = {
      id: f.id,
      field: f.field,
      color,
      pass: f.pass,
      answers: ANSWERS[color],
      evidence: f.evidence,
    };
    if (f.observed !== undefined) row.observed = f.observed;
    if (f.bound !== undefined) row.bound = f.bound;
    return [row];
  });
}
