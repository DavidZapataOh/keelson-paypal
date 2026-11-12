import { readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { REPO } from "../lib/markdown";

const SITE = process.env.DOCS_ORIGIN ?? "https://docs.keelson.finance";
const PAGES = ["/", "/quickstart/verify-an-alibi/", "/reference/api/verifyAlibi/"];
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

describe(`the deployed site at ${SITE}`, () => {
  test("serves the agent surfaces, the OpenAPI document and the samples", async () => {
    for (const path of [
      "/llms.txt",
      "/llms-full.txt",
      "/openapi.json",
      "/samples/01M6ZWZJHWRRHQEYNJAT7NMSV8.alibi",
      "/quickstart/verify-an-alibi.md",
    ]) {
      const res = await fetch(SITE + path);
      expect(res.status, path).toBe(200);
    }
    const sample = new Uint8Array(
      await (await fetch(`${SITE}/samples/01M6ZWZJHWRRHQEYNJAT7NMSV8.alibi`)).arrayBuffer(),
    );
    expect(sample).toEqual(
      new Uint8Array(
        readFileSync(join(REPO, "packages/alibi/test/fixtures/01M6ZWZJHWRRHQEYNJAT7NMSV8.alibi")),
      ),
    );
  });

  test("the home page transfers at most 150 KB", async () => {
    const page = await browser.newPage();
    let bytes = 0;
    page.on("requestfinished", async (r) => {
      bytes += (await r.sizes()).responseBodySize;
    });
    await page.goto(`${SITE}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    console.log(`home: ${bytes} bytes`);
    expect(bytes).toBeLessThanOrEqual(150_000);
    await page.close();
  });

  for (const width of [1440, 390]) {
    for (const path of PAGES) {
      test(`${path} at ${width}: no layout shift, LCP under 1.5 s, no serious accessibility issue`, async () => {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await context.newPage();
        await page.addInitScript(() => {
          const w = window as unknown as { cls: number; lcp: number };
          w.cls = 0;
          w.lcp = 0;
          new PerformanceObserver((l) => {
            for (const e of l.getEntries() as (PerformanceEntry & {
              value: number;
              hadRecentInput: boolean;
            })[]) {
              if (!e.hadRecentInput) w.cls += e.value;
            }
          }).observe({ type: "layout-shift", buffered: true });
          new PerformanceObserver((l) => {
            w.lcp = l.getEntries().at(-1)?.startTime ?? 0;
          }).observe({ type: "largest-contentful-paint", buffered: true });
        });
        await page.goto(SITE + path, { waitUntil: "networkidle" });
        const m = await page.evaluate(() => {
          const w = window as unknown as { cls: number; lcp: number };
          return { cls: w.cls, lcp: w.lcp };
        });
        console.log(`${path} ${width}: cls ${m.cls} lcp ${Math.round(m.lcp)} ms`);
        expect(m.cls).toBe(0);
        expect(m.lcp).toBeLessThan(1500);
        const { violations } = await new AxeBuilder({ page }).analyze();
        expect(
          violations
            .filter((v) => v.impact === "serious" || v.impact === "critical")
            .map((v) => v.id),
        ).toEqual([]);
        await context.close();
      });
    }
  }

  test("search finds the Alibi pages", async () => {
    const page = await browser.newPage();
    await page.goto(`${SITE}/`);
    await page.keyboard.press("ControlOrMeta+K");
    await page.getByRole("searchbox", { name: "Search the docs" }).fill("Alibi");
    await expect
      .poll(() => page.locator(".search-results li").count(), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await page.close();
  });

  test("try-it verifies the sample Alibi from the docs origin", async () => {
    const page = await browser.newPage();
    await page.goto(`${SITE}/reference/api/verifyAlibi/`);
    await page.getByRole("button", { name: "Send the sample Alibi" }).click();
    await expect
      .poll(() => page.locator(".tryit-out").textContent(), { timeout: 30_000 })
      .toMatch(/"verdict": "verified"/);
    await page.close();
  });
});
