import { chromium } from "playwright";
import { expect, test } from "vitest";
import { startPreview } from "./serve";

test("an operation keeps its request and response beside the parameters while you read", async () => {
  const preview = await startPreview();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${preview.url}/reference/api/verifyAlibi/`);
  const box = (sel: string) => page.locator(sel).first().boundingBox();
  const main = await box(".op-main");
  const aside = await box(".op-aside");
  expect((aside?.x ?? 0) - (main?.x ?? 0)).toBeGreaterThanOrEqual(400);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  const after = await box(".op-aside");
  expect(
    Math.abs(
      (after?.y ?? 0) -
        Number.parseFloat(await page.locator(".op-aside").evaluate((e) => getComputedStyle(e).top)),
    ),
  ).toBeLessThanOrEqual(1);
  await browser.close();
  await preview.stop();
});
