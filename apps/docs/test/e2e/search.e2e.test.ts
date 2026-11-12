import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startPreview } from "./serve";

let browser: Browser;
let preview: Awaited<ReturnType<typeof startPreview>>;

beforeAll(async () => {
  preview = await startPreview();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  await preview.stop();
});

describe("search", () => {
  // `K` is what the key reports with Caps Lock or Shift held.
  for (const key of ["ControlOrMeta+k", "ControlOrMeta+K", "/"]) {
    test(`${key} opens search, and it finds the Alibi pages`, async () => {
      const page = await browser.newPage();
      await page.goto(`${preview.url}/`, { waitUntil: "networkidle" });
      await page.keyboard.press(key);
      await page.getByRole("searchbox", { name: "Search the docs" }).fill("Alibi");
      await expect
        .poll(() => page.locator(".search-results li").count(), { timeout: 10_000 })
        .toBeGreaterThan(0);
      await page.close();
    });
  }
});
