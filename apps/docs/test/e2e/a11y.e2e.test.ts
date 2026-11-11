import AxeBuilder from "@axe-core/playwright";
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

describe("accessibility", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const path of [
      "/",
      "/quickstart/verify-an-alibi/",
      "/reference/api/",
      "/reference/api/post-v1-alibis-verify/",
    ]) {
      test(`${path} in ${scheme} has no serious or critical violations`, async () => {
        const context = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          colorScheme: scheme,
        });
        const page = await context.newPage();
        await page.goto(preview.url + path);
        const { violations } = await new AxeBuilder({ page }).analyze();
        const bad = violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
        expect(bad).toEqual([]);
        await context.close();
      });
    }
  }
});
