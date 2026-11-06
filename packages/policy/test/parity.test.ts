import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Context, type EngineMeta, evaluate, evaluateContext } from "../src/evaluate.ts";
import type { Extra } from "../src/extras.ts";
import { traceJcs } from "../src/trace.ts";

/** One line of the JSONL the Rust `parity` binary writes. */
interface Case {
  input: {
    mandate: unknown;
    budget_left_minor: number;
    agent: string;
    context: Omit<Context, "quantities"> & { quantities: [Context["variants"][number], number][] };
    raw_context?: unknown;
    now_ms: number;
    evidence: Record<string, string[]>;
    mandate_hash: string;
    cart_hash: string;
    extras: Extra[];
    meta: EngineMeta;
  };
  trace_jcs_hex: string;
}

const file = process.env.PARITY_FILE ?? new URL("./vectors/parity.jsonl", import.meta.url);
const cases: Case[] = readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line));

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

function run(c: Case): string {
  const i = c.input;
  const input = {
    mandate: i.mandate,
    budgetLeftMinor: i.budget_left_minor,
    agent: i.agent,
    context: i.context,
    now: new Date(i.now_ms),
    evidence: i.evidence,
    mandateHash: bytes(i.mandate_hash),
    cartHash: bytes(i.cart_hash),
  };
  const trace =
    "raw_context" in i
      ? evaluateContext(input, i.raw_context, i.meta, i.extras)
      : evaluate(input, i.meta, i.extras);
  return Buffer.from(traceJcs(trace)).toString("hex");
}

describe("parity with the Rust engine", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const pass of [1, 2]) {
    it(`emits byte-identical traces for every case (run ${pass})`, () => {
      const mismatches: number[] = [];
      cases.forEach((c, n) => {
        if (run(c) !== c.trace_jcs_hex) mismatches.push(n);
      });
      if (mismatches.length > 0) {
        const n = mismatches[0] as number;
        const c = cases[n] as Case;
        expect.soft(mismatches.length, `mismatched cases: ${mismatches.slice(0, 20)}`).toBe(0);
        expect(Buffer.from(run(c), "hex").toString("utf8")).toBe(
          Buffer.from(c.trace_jcs_hex, "hex").toString("utf8"),
        );
      }
    });
  }
});
