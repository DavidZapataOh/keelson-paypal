import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { type EvalInput, evaluate } from "../src/evaluate.ts";
import type { Extra } from "../src/extras.ts";
import { traceJcs } from "../src/trace.ts";

const BUDGET_MS = 1;
const RUNS = 5_000;

const mandate = JSON.parse(
  readFileSync(new URL("../../mandate/test/fixtures/demo-mandate.json", import.meta.url), "utf8"),
);

const sku = { sku: "sku-trail-10", size: "10", color: "black" };
const input: EvalInput = {
  mandate,
  budgetLeftMinor: 10_000,
  agent: `${mandate.agent.operator.agent_registry}/${mandate.agent.operator.agent_id}`,
  context: {
    currency: "USD",
    total_minor: 9400,
    merchant: "mrc_runfast",
    categories: ["gpt:187"],
    variants: [sku],
    max_line_qty: 1,
    max_unit_minor: 9400,
    return_days: 30,
    returns_free: true,
    quantities: [[sku, 1]],
  },
  now: new Date("2026-11-05T17:02:11.250Z"),
  evidence: { total: ["paypal.authorization.amount"] },
  mandateHash: new Uint8Array(32).fill(0x11),
  cartHash: new Uint8Array(32).fill(0x22),
};

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const meta = {
  cedar_policy: "4.14.0",
  lang: "1.3.1",
  symcc: "0.8.1",
  cvc5: "1.3.1",
  oci_digest: hash("a"),
  canonicalizer: hash("b"),
  proof_bundle_hash: hash("c"),
};

const extras = (n: number): Extra[] => [
  { type: "max_unit_price", minor: 50_000 + n },
  { type: "deny_merchant", id: "mrc_banned" },
  { type: "deny_category", id: "gpt:187" },
];

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] as number;

function measure(label: string, run: (n: number) => Uint8Array): { p50: number; p99: number } {
  for (let n = 0; n < RUNS / 10; n++) run(n);
  const samples: number[] = [];
  for (let n = 0; n < RUNS; n++) {
    const start = performance.now();
    run(RUNS + n);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p50 = percentile(samples, 0.5);
  const p99 = percentile(samples, 0.99);
  console.log(
    `${label}: runs=${RUNS} p50=${(p50 * 1000).toFixed(1)}us p99=${(p99 * 1000).toFixed(1)}us`,
  );
  return { p50, p99 };
}

const decision = evaluate(input, meta).decision;
if (decision !== "allow") throw new Error(`demo input is '${decision}', expected allow`);

const cached = measure("evaluate demo (cached policy set)", () => traceJcs(evaluate(input, meta)));
measure("evaluate demo with 3 new extras", (n) => traceJcs(evaluate(input, meta, extras(n))));

if (cached.p99 >= BUDGET_MS) {
  console.error(`p99 over ${BUDGET_MS}ms budget`);
  process.exit(1);
}
