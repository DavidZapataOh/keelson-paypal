import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startPreview } from "./serve";

const EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
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

async function styles(scheme: "light" | "dark") {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
  });
  await page.goto(`${preview.url}/quickstart/verify-an-alibi/`);
  const s = await page.evaluate(() => {
    const cs = (sel: string) => getComputedStyle(document.querySelector(sel) as Element);
    return {
      bg: cs("body").backgroundColor,
      ink: cs("body").color,
      font: cs("body").fontFamily,
      p: [cs(".prose > p").fontSize, cs(".prose > p").lineHeight],
      h1: [cs(".doc-head h1").fontSize, cs(".doc-head h1").fontWeight],
      h2: [cs(".step-title").fontSize, cs(".step-title").fontWeight],
      link: cs(".step-body a").color,
      panel: [cs(".walk-files").backgroundColor, cs(".walk-files").borderTopLeftRadius],
      code: [cs(".pane pre").fontFamily, cs(".pane pre").fontSize, cs(".pane pre").lineHeight],
      ease: cs('[role="tab"]').transitionTimingFunction,
    };
  });
  await page.close();
  return s;
}

describe("the reading theme", () => {
  test("light tokens", async () => {
    const s = await styles("light");
    expect(s.bg).toBe("rgb(255, 255, 255)");
    expect(s.ink).toBe("rgb(23, 24, 27)");
    expect(s.font.startsWith('"Instrument Sans')).toBe(true);
    expect(s.p).toEqual(["16px", "26px"]);
    expect(s.h1).toEqual(["32px", "600"]);
    expect(s.h2).toEqual(["17px", "600"]);
    expect(s.link).toBe("rgb(184, 46, 6)");
    expect(s.panel).toEqual(["rgb(242, 240, 234)", "16px"]);
    expect(s.code[0].startsWith('"Geist Mono')).toBe(true);
    expect(s.code.slice(1)).toEqual(["13px", "21px"]);
    expect(s.ease).toContain(EASE);
  });

  test("dark tokens", async () => {
    const s = await styles("dark");
    expect(s.bg).toBe("rgb(23, 24, 27)");
    expect(s.ink).toBe("rgb(242, 240, 234)");
    expect(s.link).toBe("rgb(255, 106, 69)");
    expect(s.panel[0]).toBe("rgb(31, 32, 36)");
  });
});
