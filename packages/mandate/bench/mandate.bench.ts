import { performance } from "node:perf_hooks";
import { expect, test } from "vitest";
import { hSd, mandateChallenge } from "../src/challenge.ts";
import { MERCHANT_TREE_CAPACITY, mandateCommitment, merchantTree } from "../src/commitment.ts";
import { type Mandate, parseMandate } from "../src/schema.ts";
import { buildSdPayload } from "../src/sd.ts";
import demo from "../test/fixtures/demo-mandate.json" with { type: "json" };

const BUDGET_MS = 5;
const RUNS = 2000;
const WARMUP = 200;

const mandate: Mandate = parseMandate(demo);

async function derive(): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const { payloadSd } = await buildSdPayload(mandate, () =>
    crypto.getRandomValues(new Uint8Array(16)),
  );
  const cm = await mandateCommitment(mandate, salt);
  return mandateChallenge(hSd(payloadSd), cm);
}

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] as number;

test("mandate derivation: buildSdPayload + hSd + mandateCommitment + mandateChallenge", async () => {
  for (let i = 0; i < WARMUP; i++) await derive();
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await derive();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p50 = percentile(samples, 0.5);
  const p99 = percentile(samples, 0.99);
  console.table([
    { runs: RUNS, p50_ms: +p50.toFixed(3), p99_ms: +p99.toFixed(3), budget_ms: BUDGET_MS },
  ]);
  expect(p99).toBeLessThan(BUDGET_MS);
});

test("a full merchant tree builds within budget", async () => {
  const full = Array.from({ length: MERCHANT_TREE_CAPACITY }, (_, i) => `mrc_${i}`);
  await merchantTree(full);
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    await merchantTree(full);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p50 = percentile(samples, 0.5);
  console.table([{ leaves: full.length, p50_ms: +p50.toFixed(1), budget_ms: 100 }]);
  expect(p50).toBeLessThan(100);
});
