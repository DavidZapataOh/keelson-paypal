import AxeBuilder from "@axe-core/playwright";
import { type Browser, chromium, devices } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { serveOut } from "./static";

const API = "https://api.keelson.finance";
let site: Awaited<ReturnType<typeof serveOut>>;
let browser: Browser;

beforeAll(async () => {
  site = await serveOut();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  mobile: devices["Pixel 7"],
} as const;

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

describe.each(Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[])("signed out on %s", (kind) => {
  for (const [path, heading] of [
    ["/judge/", "Judge Keelson in five minutes, on the live system."],
    ["/status/", "Is Keelson up?"],
  ] as const) {
    test(`${path} says what is real and what is sandbox`, async () => {
      const context = await browser.newContext(VIEWPORTS[kind]);
      // With the API unreachable, both pages still render and say so.
      await context.route(`${API}/**`, (route) => route.abort("connectionrefused"));
      const page = await context.newPage();
      await page.goto(`${site.base}${path}`);
      await page.getByRole("heading", { level: 1, name: heading }).waitFor();
      await page.getByRole("cell", { name: "PayPal", exact: true }).waitFor();
      expect(await page.getByRole("cell", { name: "Sandbox" }).first().isVisible()).toBe(true);
      expect(await page.getByRole("cell", { name: "Testnet" }).first().isVisible()).toBe(true);
      if (path === "/judge/") {
        expect(await page.getByRole("button", { name: "Start Judge Mode" }).isEnabled()).toBe(true);
      }
      const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await context.close();
    });
  }

  test("/status/ keeps its shape while the first report loads", async () => {
    const context = await browser.newContext(VIEWPORTS[kind]);
    // The live report, held back a moment so it lands after first paint.
    await context.route(`${API}/status`, async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fulfill({ response });
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      (window as unknown as { cls: number }).cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as { value: number }[]) {
          (window as unknown as { cls: number }).cls += e.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto(`${site.base}/status/`);
    await page.getByText(/^Checked /).waitFor();
    const cls = await page.evaluate(() => (window as unknown as { cls: number }).cls);
    expect(cls).toBeLessThan(0.1);
    await context.close();
  });
});
