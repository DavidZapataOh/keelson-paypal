/** Times offline verification of a v1 Alibi and of a v2 one around the same purchase. */
import { verifyAlibi } from "../src/verify/index.ts";
import { fixtures } from "../test/fixtures.ts";
import { receiptKeys, v2Bundle } from "../test/v2.ts";

const RUNS = Number(process.env.RUNS ?? 50);
const now = new Date("2026-11-10T00:00:00Z");
const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] ?? 0;
};
async function time(fn: () => Promise<unknown>): Promise<number[]> {
  await fn();
  const out: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    await fn();
    out.push(performance.now() - t);
  }
  return out;
}

const v1 = fixtures.find((f) => f.mode === "2of2")?.bundle;
if (!v1) throw new Error("no 2of2 fixture");
const v2 = v2Bundle();
const a = await time(() => verifyAlibi(v1, { now }));
const b = await time(() => verifyAlibi(v2, { now, receiptKeys }));
console.log(`verify v1 p50 ${q(a, 0.5).toFixed(1)} ms p95 ${q(a, 0.95).toFixed(1)} ms`);
console.log(`verify v2 p50 ${q(b, 0.5).toFixed(1)} ms p95 ${q(b, 0.95).toFixed(1)} ms`);
if (q(b, 0.95) > q(a, 0.95) + 15) {
  console.error("v2 is more than 15 ms slower than v1 at p95");
  process.exit(1);
}
