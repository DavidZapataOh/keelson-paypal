import { chromium } from "playwright";
import { expect, test } from "vitest";
import { startPreview } from "./serve";

test("How it works shows its diagrams as pictures, under the site's CSP", async () => {
  const preview = await startPreview();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content.Security.Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  await page.goto(`${preview.url}/concepts/how-it-works/`, { waitUntil: "networkidle" });
  await expect
    .poll(() => page.locator("svg[aria-roledescription]").count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(4);
  expect(await page.getByText(/^\s*accTitle:/).count()).toBe(0);
  expect(violations).toEqual([]);
  await browser.close();
  await preview.stop();
});
