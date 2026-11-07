/**
 * Times `verifyTimestamp` on the captured tokens, in Node and in Chromium, and reports the
 * minified and gzipped verifier bundle.
 *
 *   node bench/verify.bench.ts
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { chromium } from "playwright";
import { bundleTimestamp } from "../scripts/bundle.ts";
import { verifyTimestamp } from "../src/verify.ts";
import { imprint, tokens } from "../test/tokens.ts";

const RUNS = 100;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const round = (ms: number) => Math.round(ms * 10) / 10;

const bundle = await bundleTimestamp();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.route("http://localhost/", (route) =>
  route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
);
await page.goto("http://localhost/");
await page.addScriptTag({ content: bundle.code });
const inBrowser = await page.evaluate(
  async ([hexTokens, hexImprint, runs]) => {
    const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
    const api = (
      globalThis as unknown as {
        timestamp: { verifyTimestamp: (t: Uint8Array, i: Uint8Array) => Promise<unknown> };
      }
    ).timestamp;
    const out: Record<string, number[]> = {};
    for (const [tsa, hex] of Object.entries(hexTokens)) {
      out[tsa] = [];
      for (let i = 0; i < runs; i++) {
        const start = performance.now();
        await api.verifyTimestamp(bytes(hex), bytes(hexImprint));
        out[tsa].push(performance.now() - start);
      }
    }
    return out;
  },
  [
    Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, bytesToHex(v)])),
    bytesToHex(imprint),
    RUNS,
  ] as const,
);
await browser.close();

const result: Record<string, unknown> = {
  bundleKB: round(bundle.bytes / 1024),
  bundleGzipKB: round(bundle.gzip / 1024),
};
for (const [tsa, token] of Object.entries(tokens)) {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await verifyTimestamp(token, imprint);
    times.push(performance.now() - start);
  }
  result[tsa] = {
    nodeMedianMs: round(median(times)),
    browserMedianMs: round(median(inBrowser[tsa] ?? [])),
  };
}
console.log(JSON.stringify(result, null, 2));
