import { join } from "node:path";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import { REPO } from "../lib/markdown";

test("a real Alibi verifies in the browser within a minute", { timeout: 120_000 }, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("https://verify.keelson.finance");
  const started = Date.now();
  await page
    .locator('input[type="file"]')
    .setInputFiles(join(REPO, "packages/alibi/test/fixtures/01M6ZWZJHWRRHQEYNJAT7NMSV8.alibi"));
  await page.getByRole("heading", { name: "Verified", exact: true }).waitFor({ timeout: 60_000 });
  const ms = Date.now() - started;
  console.log(`verified in the browser in ${ms} ms`);
  expect(ms).toBeLessThan(60_000);
  await browser.close();
});
