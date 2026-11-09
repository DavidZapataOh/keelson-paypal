// Times the deployed verifier in Chromium: warm verification of a dropped Alibi (4x CPU throttle
// and unthrottled), and a cold QR link to its verdict. Usage:
//   node bench/verify.bench.ts <site> <alibi.json|.alibi|.pdf> [<qr link path>]
import { chromium, type Page } from "playwright";

const [site = "https://verify.keelson.finance", file, link] = process.argv.slice(2);
const RUNS = Number(process.env.RUNS ?? 20);

const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0;
const line = (name: string, xs: number[]) =>
  console.log(
    `${name}: p50 ${pct(xs, 50).toFixed(0)} ms, p95 ${pct(xs, 95).toFixed(0)} ms (n=${xs.length})`,
  );

async function settled(page: Page, run?: number): Promise<string> {
  const scope = run === undefined ? "" : `[data-run="${run}"] `;
  const el = page.locator(`${scope}[data-verdict]:not([data-verdict=running])`);
  await el.waitFor({ timeout: 60_000 });
  return (await el.getAttribute("data-verdict")) ?? "";
}

const browser = await chromium.launch();

if (file) {
  for (const rate of [4, 1]) {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    await page.goto(site);
    const times: number[] = [];
    let verdict = "";
    for (let i = 0; i <= RUNS; i++) {
      const start = performance.now();
      await page.setInputFiles("[data-testid=file]", file);
      verdict = await settled(page, i + 1);
      if (i > 0) times.push(performance.now() - start);
      else
        console.log(
          `first drop, CPU ${rate}x, chain read included: ${(performance.now() - start).toFixed(0)} ms`,
        );
    }
    line(`warm verification, CPU ${rate}x, chain answer reused (${verdict})`, times);
    const report = await page.locator("[data-verdict]").textContent();
    console.log(`  ${report?.match(/\d+ checks in \d+ ms[^\n]*/)?.[0] ?? ""}`);
    await page.close();
  }
}

if (link) {
  const times: number[] = [];
  let verdict = "";
  for (let i = 0; i < Math.min(RUNS, 10); i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const start = performance.now();
    await page.goto(`${site}${link}`);
    verdict = await settled(page);
    times.push(performance.now() - start);
    await context.close();
  }
  line(`cold QR link (${verdict})`, times);
}

await browser.close();
