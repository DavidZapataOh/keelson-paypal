/**
 * Times `verifySigner` for both legs on the captured evidence: with no cache, and on a cache hit.
 *
 *   node bench/cache.bench.ts
 */
import "@abraham/reflection";
import { AttestationCache } from "../src/cache.ts";
import { verifySigner } from "../src/signer.ts";
import { legs } from "../test/legs.ts";

const RUNS = 50;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const round = (ms: number) => Math.round(ms * 100) / 100;

async function time(run: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  return round(median(samples));
}

const out: Record<string, { coldMs: number; hitMs: number }> = {};
for (const [att, expect] of await legs()) {
  const cache = new AttestationCache();
  await verifySigner(att, { ...expect, cache });
  out[att.tee] = {
    coldMs: await time(() => verifySigner(att, expect)),
    hitMs: await time(() => verifySigner(att, { ...expect, cache })),
  };
}
console.log(JSON.stringify({ runs: RUNS, ...out }));
