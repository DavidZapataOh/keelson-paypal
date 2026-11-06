import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { evaluate, evaluateContext } from "../src/evaluate.ts";
import { traceJcs } from "../src/trace.ts";

/** One evaluation with the policy set Cedar already holds: no extras, or the last ones seen. */
const BUDGET_MS = 1;
/** One evaluation with extras Cedar has not seen yet, which compiles and parses them. */
const COLD_EXTRAS_BUDGET_MS = 3;
const ROUNDS = 20;

const cases = readFileSync(new URL("../test/vectors/parity.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line).input);

function run(i: (typeof cases)[number]): Uint8Array {
  const input = {
    mandate: i.mandate,
    budgetLeftMinor: i.budget_left_minor,
    agent: i.agent,
    context: i.context,
    now: new Date(i.now_ms),
    evidence: i.evidence,
    mandateHash: new Uint8Array(32),
    cartHash: new Uint8Array(32),
  };
  const trace =
    "raw_context" in i
      ? evaluateContext(input, i.raw_context, i.meta, i.extras)
      : evaluate(input, i.meta, i.extras);
  return traceJcs(trace);
}

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] as number;

function measure(label: string, budget: number, warm: boolean) {
  for (const c of cases) run(c);
  const samples: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    for (const c of cases) {
      if (!warm && c.extras.length === 0) continue;
      if (warm) run(c);
      const start = performance.now();
      run(c);
      samples.push(performance.now() - start);
    }
  }
  samples.sort((a, b) => a - b);
  const p50 = percentile(samples, 0.5);
  const p99 = percentile(samples, 0.99);
  console.table([
    { label, runs: samples.length, p50_ms: +p50.toFixed(3), p99_ms: +p99.toFixed(3), budget },
  ]);
  expect(p99).toBeLessThan(budget);
}

test("evaluate + traceJcs over the parity sample", () => {
  measure("preparsed policy set", BUDGET_MS, true);
});

test("evaluate + traceJcs with extras not seen before", () => {
  measure("new extras", COLD_EXTRAS_BUDGET_MS, false);
});
