import { mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startPreview } from "./serve";

const SCREENS = fileURLToPath(new URL("./__screens__/", import.meta.url));
const PAGES = [
  { name: "home", path: "/", step: undefined },
  { name: "walkthrough", path: "/quickstart/verify-an-alibi/", step: 1 },
  { name: "api", path: "/reference/api/verifyAlibi/", step: undefined },
] as const;
let browser: Browser;
let preview: Awaited<ReturnType<typeof startPreview>>;

beforeAll(async () => {
  mkdirSync(SCREENS, { recursive: true });
  preview = await startPreview();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  await preview.stop();
});

describe("the pages owners review", () => {
  for (const width of [1440, 390]) {
    for (const p of PAGES) {
      test(`${p.name} at ${width} renders without layout shift`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.addInitScript(() => {
          (window as unknown as { cls: number }).cls = 0;
          new PerformanceObserver((list) => {
            for (const e of list.getEntries() as (PerformanceEntry & {
              value: number;
              hadRecentInput: boolean;
            })[]) {
              if (!e.hadRecentInput) (window as unknown as { cls: number }).cls += e.value;
            }
          }).observe({ type: "layout-shift", buffered: true });
        });
        await page.goto(preview.url + p.path, { waitUntil: "networkidle" });
        if (p.step !== undefined && width > 1024) {
          await page.evaluate((n) => {
            const el = document.querySelectorAll<HTMLElement>("[data-step]")[n];
            if (el)
              scrollTo({
                top: el.getBoundingClientRect().top + scrollY - innerHeight * 0.37,
                behavior: "instant",
              });
          }, p.step);
          await page.waitForTimeout(500);
        }
        const file = `${SCREENS}${p.name}-${width}.png`;
        await page.screenshot({ path: file });
        expect(statSync(file).size).toBeGreaterThan(10_000);
        expect(await page.evaluate(() => (window as unknown as { cls: number }).cls)).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        await page.close();
      });
    }
  }
});
