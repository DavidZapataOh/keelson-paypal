import { appendFileSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { expect, test } from "vitest";

// The judge's journey on the deployed app, from a clean browser with no keys: start Judge Mode,
// walk every step on production data, open the merchant console as the judge and come back.
// Runs hourly; the whole tour must take under five minutes.
const ORIGIN = process.env.JUDGE_LIVE_ORIGIN;
const BUDGET_MS = 5 * 60_000;

async function next(page: Page, title: string) {
  await page.getByRole("button", { name: `Next: ${title}` }).click();
  await page.getByRole("heading", { level: 1, name: title }).waitFor();
}

test.runIf(ORIGIN)(
  "a judge completes the tour without keys in under five minutes",
  async () => {
    const started = Date.now();
    const marks: Record<string, number> = {};
    const mark = (step: string) => {
      marks[step] = Date.now() - started;
    };
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(`${ORIGIN}/judge/`);
      await page.getByRole("button", { name: "Start Judge Mode" }).click();
      await page.getByRole("heading", { level: 1, name: "The mandate" }).waitFor();
      await page.locator('[data-slot="liability-field"]').first().waitFor();
      mark("mandate");

      await next(page, "The agent shops");
      await page.getByText("Injected listing").waitFor();
      await page.getByText("By both TEEs (2 of 2)").waitFor();
      mark("agent");

      await next(page, "Try to cheat the Alibi");
      const verifier = page.frameLocator('iframe[title="Alibi verifier"]');
      await verifier.getByRole("button").first().waitFor({ timeout: 60_000 });
      mark("alibi");

      await next(page, "Anonymous, and still accountable");
      await page
        .frameLocator('iframe[title="Anonymous proof verifier"]')
        .locator("[data-anonymous=pass]")
        .waitFor({ timeout: 60_000 });
      mark("anonymous");

      await next(page, "Catch the log lying");
      await page.getByText("Bond slashed").first().waitFor();
      await page
        .getByRole("link", { name: /Arbiscan/ })
        .first()
        .waitFor();
      mark("equivocation");

      await next(page, "A dispute arrives");
      await page.getByText("PayPal dispute", { exact: true }).waitFor();
      mark("dispute");

      await next(page, "Verdict and settlement");
      await page.getByText("At fault", { exact: true }).waitFor();
      mark("verdict");

      await next(page, "Merchant forensics");
      await page.getByRole("link", { name: "Open the merchant console" }).click();
      await page.getByText("Judge Mode · read only").waitFor({ timeout: 60_000 });
      await page.getByTestId("settlement-summary").waitFor();
      expect(await page.getByRole("button", { name: "Change" }).count()).toBe(0);
      await page.getByRole("link", { name: "Back to the tour" }).click();
      await page.getByRole("heading", { level: 1, name: "Merchant forensics" }).waitFor();
      mark("forensics");

      await next(page, "Operator grade");
      await page.getByText("Covered purchases", { exact: true }).waitFor();
      mark("grade");

      await next(page, "Red-team scoreboard");
      await page
        .getByText(/Hijacked \d+ of \d+ times/)
        .first()
        .waitFor();
      mark("scoreboard");

      await next(page, "Live status");
      await page.getByText("TEE leg A · Intel TDX").waitFor();
      mark("status");

      const total = Date.now() - started;
      const summary = { origin: ORIGIN, totalMs: total, marks, errors };
      console.log(JSON.stringify(summary));
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `### Judge journey\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`,
        );
      }
      expect(errors).toEqual([]);
      expect(total).toBeLessThan(BUDGET_MS);
    } catch (err) {
      // The hourly alert should say what the judge saw, not only which locator timed out.
      const seen =
        (await page
          .locator("main")
          .textContent()
          .catch(() => "")) ?? "";
      throw new Error(
        `${(err as Error).message}\n--- page ---\n${seen.slice(0, 2_000)}\n--- errors ---\n${errors.join("\n")}`,
      );
    } finally {
      await context.close();
      await browser.close();
    }
  },
  BUDGET_MS + 60_000,
);
