/**
 * Times verification of both legs on the captured evidence, in Chromium and in Node, and reports
 * the gzipped bundle size.
 *
 *   node bench/browser.bench.ts
 */
import { chromium } from "playwright";
import { bundleAttest } from "../scripts/bundle.ts";
import { verifyLegs } from "../src/signer.ts";
import { legs } from "../test/legs.ts";

const RUNS = 20;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const round = (ms: number) => Math.round(ms * 10) / 10;

const input = await legs();
const serial = input.map(([att, e]) => [att, { ...e, now: e.now.toISOString() }]);

const bundle = await bundleAttest();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.route("http://localhost/", (route) =>
  route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
);
await page.goto("http://localhost/");
await page.addScriptTag({ content: bundle.code });
const inBrowser = await page.evaluate(
  async ([serialized, runs]) => {
    const api = (
      globalThis as unknown as { attest: { verifyLegs: (...a: unknown[]) => Promise<unknown> } }
    ).attest;
    const dated = ([att, e]: [unknown, Record<string, unknown>]) =>
      [att, { ...e, now: new Date(e.now as string) }] as never;
    const once = async () => {
      const start = performance.now();
      await api.verifyLegs(...(serialized as [never, never]).map(dated));
      return performance.now() - start;
    };
    const cold = await once();
    const warm: number[] = [];
    for (let i = 0; i < (runs as number); i++) warm.push(await once());
    return { cold, warm };
  },
  [serial, RUNS] as const,
);
await browser.close();

const once = async () => {
  const start = performance.now();
  await verifyLegs(...input);
  return performance.now() - start;
};
const nodeCold = await once();
const nodeWarm: number[] = [];
for (let i = 0; i < RUNS; i++) nodeWarm.push(await once());

console.log(
  JSON.stringify(
    {
      bundleGzipKB: round(bundle.gzip / 1024),
      bundleKB: round(bundle.bytes / 1024),
      browserColdMs: round(inBrowser.cold),
      browserWarmMedianMs: round(median(inBrowser.warm)),
      browserWarmMaxMs: round(Math.max(...inBrowser.warm)),
      nodeColdMs: round(nodeCold),
      nodeWarmMedianMs: round(median(nodeWarm)),
    },
    null,
    2,
  ),
);
