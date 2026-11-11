import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startPreview } from "./serve";

const PAGE = "/quickstart/verify-an-alibi/";
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

const range = (lines: string | null) => {
  const [a, b] = (lines ?? "").split("-").map(Number);
  return a ? (b || a) - a + 1 : 0;
};

const state = (page: Page) =>
  page.evaluate(() => {
    const step = document.querySelector<HTMLElement>("[data-step][data-active]");
    return {
      file: step?.dataset.file,
      lines: step?.dataset.lines ?? null,
      tab: document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.textContent,
      highlighted: document.querySelectorAll(".pane:not([hidden]) .line.is-hl").length,
      top: Math.round(document.querySelector(".walk-files")?.getBoundingClientRect().top ?? -1),
      stickyAt: Number.parseFloat(
        getComputedStyle(document.querySelector(".walk-files") as Element).top,
      ),
    };
  });

describe("the synced code panel", () => {
  test("follows the reader", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(preview.url + PAGE);
    const steps = await page.$$eval("[data-step]", (els) =>
      els.map((e) => ({ file: e.getAttribute("data-file"), lines: e.getAttribute("data-lines") })),
    );
    expect(new Set(steps.map((s) => s.file)).size).toBeGreaterThanOrEqual(3);
    let stuck = false;
    for (const [i, step] of steps.entries()) {
      // Put the step's top inside the band the panel listens to: 35% to 40% of the viewport.
      await page.evaluate((n) => {
        const el = document.querySelectorAll<HTMLElement>("[data-step]")[n];
        if (el)
          scrollTo({
            top: el.getBoundingClientRect().top + scrollY - innerHeight * 0.37,
            behavior: "instant",
          });
      }, i);
      await page.waitForTimeout(350);
      const s = await state(page);
      expect(s.file).toBe(step.file);
      expect(s.tab).toBe(step.file);
      expect(s.highlighted).toBe(range(step.lines));
      // Once the panel reaches its sticky offset, it stays there for every later step.
      stuck ||= Math.abs(s.top - s.stickyAt) <= 1;
      if (stuck) expect(Math.abs(s.top - s.stickyAt)).toBeLessThanOrEqual(1);
    }
    expect(stuck).toBe(true);
    await page.close();
  });

  test("shows a file when its tab is clicked, and copies it whole", async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    await page.goto(preview.url + PAGE);
    await page.getByRole("tab", { name: "verify.ts" }).click();
    expect(await page.locator('.pane[data-pane="verify.ts"]').isVisible()).toBe(true);
    await page.getByRole("button", { name: "Copy" }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('fetch("https://api.keelson.finance/v1/alibis/verify"');
    expect(copied).toContain("console.log(verdict, mode)");
    await context.close();
  });

  test("narrow screens carry each step's own lines", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    for (const path of ["/", PAGE]) {
      await page.goto(preview.url + path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    }
    const steps = await page.$$eval("[data-step][data-lines]", (els) =>
      els.map((e) => ({
        lines: e.getAttribute("data-lines"),
        inline: e.querySelectorAll(".inline-code .line").length,
      })),
    );
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) expect(s.inline).toBe(range(s.lines));
    await page.close();
  });

  test("scrolls the pane instantly under reduced motion", async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(preview.url + PAGE);
    const behavior = await page.evaluate(() => {
      const pre = document.querySelector<HTMLElement>(".pane pre");
      let seen: string | undefined;
      if (pre) {
        const original = pre.scrollTo.bind(pre);
        pre.scrollTo = ((o: ScrollToOptions) => {
          seen = o.behavior;
          original(o);
        }) as typeof pre.scrollTo;
      }
      const el = document.querySelectorAll<HTMLElement>("[data-step]")[1];
      if (el)
        scrollTo({
          top: el.getBoundingClientRect().top + scrollY - innerHeight * 0.37,
          behavior: "instant",
        });
      return new Promise<string | undefined>((ok) => setTimeout(() => ok(seen), 400));
    });
    expect(behavior).toBe("auto");
    await context.close();
  });
});
