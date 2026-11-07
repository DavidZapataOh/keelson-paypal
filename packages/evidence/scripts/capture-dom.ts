import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { COMPUTED_STYLES } from "../src/dom.ts";
import { serve } from "../test/server.ts";

const pages = ["product", "checkout", "attack"];
const site = await serve();
const browser = await chromium.launch();
try {
  for (const name of pages) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.goto(`${site.url}/${name}.html`);
    await page.locator("body[data-ready]").waitFor({ state: "attached" });
    const cdp = await context.newCDPSession(page);
    const snapshot = await cdp.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [...COMPUTED_STYLES],
      includeDOMRects: true,
      includePaintOrder: true,
      includeBlendedBackgroundColors: true,
      includeTextColorOpacities: true,
    });
    const out = new URL(`../test/snapshots/${name}.json`, import.meta.url);
    await writeFile(out, `${JSON.stringify({ url: page.url(), snapshot })}\n`);
    await context.close();
  }
} finally {
  await browser.close();
  await site.close();
}
