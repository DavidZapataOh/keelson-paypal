import Kernel from "@onkernel/sdk";
import { generateHybridIdentity, identityToRecipient } from "age-encryption";
import { type BrowserContext, chromium } from "playwright";
import { captureEvidence, startRecorder } from "../src/capture/index.ts";
import type { PiiValues } from "../src/index.ts";
import { routePages, serve } from "../test/server.ts";

const SAMPLES = Number(process.env.SAMPLES ?? 100);
const BUDGET_MS = 400;
const STEPS = [
  "screenshot",
  "piiRects",
  "domSnapshot",
  "ax",
  "mhtml",
  "har",
  "normalize",
  "redaction",
  "mask",
  "detector",
  "age",
  "manifest",
  "total",
];

const env = process.env;
const buyer: { pii: PiiValues; fill: Record<string, string> } | undefined =
  env.PAYPAL_SANDBOX_BUYER_EMAIL &&
  env.PAYPAL_SANDBOX_BUYER_NAME &&
  env.PAYPAL_SANDBOX_BUYER_ADDRESS
    ? (() => {
        const a = JSON.parse(env.PAYPAL_SANDBOX_BUYER_ADDRESS) as Record<string, string>;
        const address = [a.line1, a.city, a.state, a.postal, a.country].map((v) => v ?? "");
        return {
          pii: {
            name: env.PAYPAL_SANDBOX_BUYER_NAME,
            email: env.PAYPAL_SANDBOX_BUYER_EMAIL,
            address,
          },
          fill: {
            "#name": env.PAYPAL_SANDBOX_BUYER_NAME,
            "#email": env.PAYPAL_SANDBOX_BUYER_EMAIL,
            "#address1": address[0],
            "#city": address[1],
            "#state": address[2],
            "#zip": address[3],
            "#country": address[4],
          } as Record<string, string>,
        };
      })()
    : undefined;

const recipient = await identityToRecipient(await generateHybridIdentity());
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] ?? Number.NaN;
};
const ms = (x: number) => x.toFixed(1);

async function bench(where: string, context: BrowserContext, origin: string): Promise<boolean> {
  let within = true;
  for (const path of ["product.html", "checkout.html"] as const) {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });
    const recorder = await startRecorder(page);
    await page.goto(`${origin}/${path}`);
    await page.locator("body[data-ready]").waitFor({ state: "attached" });
    const withPii = path === "checkout.html" && buyer !== undefined;
    if (withPii) {
      for (const [selector, value] of Object.entries(buyer.fill))
        await page.locator(selector).fill(value);
      await page.locator("#pay").focus();
    }
    const llmObservation = await page.locator("body").ariaSnapshot();
    const salts = Array.from({ length: 9 }, () => crypto.getRandomValues(new Uint8Array(32)));
    const timings: Record<string, number[]> = Object.fromEntries(STEPS.map((s) => [s, []]));
    const roots = new Set<string>();
    let size = 0;
    for (let k = 0; k < SAMPLES + 3; k++) {
      const capture = await captureEvidence(recorder, {
        product: {},
        cart: {},
        llmObservation,
        recipient,
        salts,
        ...(withPii ? { pii: buyer.pii } : {}),
      });
      if (k < 3) continue;
      for (const s of STEPS) timings[s]?.push(capture.timings[s] ?? 0);
      if (!withPii) roots.add(capture.manifest.root);
      size = capture.items
        .filter((i) => !i.type.endsWith(".original"))
        .reduce((sum, i) => sum + i.bytes.length, 0);
    }
    await recorder.stop();
    await page.close();

    const total = timings.total ?? [];
    const p95 = pct(total, 0.95);
    within &&= p95 < BUDGET_MS;
    const label = `${where}, ${path}${withPii ? " (PII redacted, originals sealed)" : ""}`;
    console.log(`\n### ${label}, ${SAMPLES} captures\n`);
    console.log("| step | p50 ms | p95 ms |\n|---|---|---|");
    for (const s of STEPS) {
      const xs = timings[s] ?? [];
      console.log(`| ${s} | ${ms(pct(xs, 0.5))} | ${ms(pct(xs, 0.95))} |`);
    }
    console.log(
      `\ncapture + manifest p95 ${ms(p95)} ms (budget < ${BUDGET_MS} ms); public bundle ${(size / 1024).toFixed(1)} KiB`,
    );
    if (!withPii) console.log(`distinct roots with pinned salts: ${roots.size} (want 1)`);
  }
  return within;
}

let ok = true;
const site = await serve();
const local = await chromium.launch();
try {
  ok = (await bench("local Chromium", await local.newContext(), site.url)) && ok;
} finally {
  await local.close();
  await site.close();
}

if (env.KERNEL_API_KEY) {
  const kernel = new Kernel();
  const created = await kernel.browsers.create({ headless: true, timeout_seconds: 600 });
  try {
    const remote = await chromium.connectOverCDP(created.cdp_ws_url);
    const context = remote.contexts()[0] ?? (await remote.newContext());
    const origin = "https://store.keelson.test";
    await routePages(context, origin);
    ok = (await bench("KERNEL over CDP", context, origin)) && ok;
    await remote.close();
  } finally {
    await kernel.browsers.deleteByID(created.session_id);
  }
}
if (!ok) process.exitCode = 1;
