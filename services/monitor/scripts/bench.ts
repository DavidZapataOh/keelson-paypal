// Cold in-browser verification time on the monitor page (checkpoint,
// consistency from a saved checkpoint, inclusion of leaf 0), median of ten
// loads in fresh browser contexts, and the verifier's transfer size.
import { chromium } from "playwright";

const url = process.env.MONITOR_URL;
if (!url) throw new Error("MONITOR_URL is required");

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

const browser = await chromium.launch();
const verify: number[] = [];
const wasm: number[] = [];
const total: number[] = [];
let saved: string | null = null;
let origin = "";
let transfer = 0;
for (let i = 0; i < 11; i++) {
  const context = await browser.newContext();
  if (saved) {
    await context.addInitScript(
      ([key, note]) => localStorage.setItem(key, note),
      [`keelson-monitor:checkpoint:${origin}`, saved],
    );
  }
  const page = await context.newPage();
  page.on("response", async (res) => {
    if (res.url().endsWith(".wasm"))
      transfer = Number((await res.headerValue("content-length")) ?? 0);
  });
  await page.goto(url);
  await page.locator("body[data-ready]").waitFor({ state: "attached", timeout: 60_000 });
  if (i === 0) {
    // The first load saves the checkpoint the next ones prove consistency from.
    origin = await page.locator("#origin").inputValue();
    saved = await page.evaluate(
      (key) => localStorage.getItem(key),
      `keelson-monitor:checkpoint:${origin}`,
    );
  } else {
    const body = page.locator("body");
    verify.push(Number(await body.getAttribute("data-verify-ms")));
    wasm.push(Number(await body.getAttribute("data-wasm-ms")));
    total.push(await page.evaluate(() => Math.round(performance.now())));
    if ((await page.locator("#verdict").getAttribute("data-state")) !== "ok")
      throw new Error("verification failed");
  }
  await context.close();
}
await browser.close();
console.log(`| Metric | Value |
|---|---|
| Verification (checkpoint + consistency + inclusion), cold median of ${verify.length} | ${median(verify)} ms |
| verifier.wasm download and instantiation, median | ${median(wasm)} ms |
| Navigation to verdict, median | ${median(total)} ms |
| verifier.wasm transfer (gzip) | ${transfer} bytes |`);
