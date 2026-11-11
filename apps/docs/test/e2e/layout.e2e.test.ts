import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startPreview } from "./serve";

const PAGES = ["/", "/quickstart/verify-an-alibi/", "/reference/api/post-v1-alibis-verify/"];
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

describe("layout", () => {
  for (const width of [1440, 390]) {
    for (const path of PAGES) {
      test(`${path} at ${width}: every code line fits its panel or wraps`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.goto(preview.url + path);
        const clipped = await page.evaluate(() => {
          const out: string[] = [];
          for (const pre of document.querySelectorAll<HTMLElement>("pre")) {
            const hidden = pre.closest<HTMLElement>("[hidden]");
            if (hidden) hidden.hidden = false;
            if (pre.offsetParent && pre.scrollWidth > pre.clientWidth + 1) {
              out.push(
                `${pre.closest("[data-pane]")?.getAttribute("data-pane") ?? pre.className}: ${pre.scrollWidth} > ${pre.clientWidth}`,
              );
            }
            if (hidden) hidden.hidden = true;
          }
          return out;
        });
        expect(clipped).toEqual([]);
        await page.close();
      });
    }
  }

  test("empty code lines keep their height, so line numbers never overlap", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${preview.url}/quickstart/verify-an-alibi/`);
    const short = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".pane:not([hidden]) .line")]
        .map((l, i) => ({ i: i + 1, h: l.getBoundingClientRect().height, lh: Number.parseFloat(getComputedStyle(l).lineHeight) }))
        .filter((l) => l.h < l.lh - 0.5)
        .map((l) => l.i),
    );
    expect(short).toEqual([]);
    await page.close();
  });

  test("the header is opaque, with nothing blurred behind it", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${preview.url}/quickstart/verify-an-alibi/`);
    await page.mouse.wheel(0, 300);
    const header = await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector(".topbar") as Element);
      return { bg: s.backgroundColor, backdrop: s.backdropFilter };
    });
    expect(header.backdrop).toBe("none");
    expect(header.bg).toMatch(/^rgb\(/);
    await page.close();
  });
});
