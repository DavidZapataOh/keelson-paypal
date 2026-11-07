import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Capture, captureEvidence, type Har, startRecorder } from "../src/capture/index.ts";
import { type SealedItem, verifyDisclosure } from "../src/index.ts";
import { disclose } from "../src/manifest.ts";
import { serve } from "./server.ts";

let browser: Browser;
let context: BrowserContext;
let site: Awaited<ReturnType<typeof serve>>;
let cart: unknown;

beforeAll(async () => {
  [browser, site] = await Promise.all([chromium.launch(), serve()]);
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  cart = await (await fetch(`${site.url}/api/cart.json`)).json();
});
afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const item = (c: Capture, type: string) => c.items.find((i) => i.type === type) as SealedItem;

async function captureProduct(salts?: Uint8Array[]): Promise<Capture> {
  const page = await context.newPage();
  const recorder = await startRecorder(page);
  try {
    await page.goto(`${site.url}/product.html`);
    await page.locator("body[data-ready]").waitFor({ state: "attached" });
    await recorder.settled();
    const xhr = recorder.requests.find((r) => r.url.endsWith("/api/product.json"));
    const product = JSON.parse(decode(xhr?.body ?? new Uint8Array()));
    const llmObservation = await page.locator("body").ariaSnapshot();
    return await captureEvidence(recorder, {
      product,
      cart,
      llmObservation,
      ...(salts ? { salts } : {}),
    });
  } finally {
    await recorder.stop();
    await page.close();
  }
}

describe("capture", () => {
  let capture: Capture;
  beforeAll(async () => {
    capture = await captureProduct();
  });

  test("captures every item that applies, in manifest order", () => {
    expect(capture.manifest.items.map((i) => i.type)).toEqual([
      "api.product",
      "api.cart",
      "llm.observation",
      "dom.snapshot",
      "ax.tree",
      "hidden.text",
      "screenshot",
      "mhtml",
      "har",
    ]);
    for (let k = 0; k < capture.items.length; k++) {
      expect(verifyDisclosure(capture.manifest.root, disclose(capture.items, k))).toBe(true);
    }
  });

  test("the screenshot is a PNG of the viewport", () => {
    const png = PNG.sync.read(Buffer.from(item(capture, "screenshot").bytes));
    expect([png.width, png.height]).toEqual([1280, 720]);
  });

  test("the MHTML opens in Chromium and shows the product", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keelson-mhtml-"));
    const file = join(dir, "page.mhtml");
    const mhtml = decode(item(capture, "mhtml").bytes);
    expect(mhtml).not.toMatch(/^Date:/m);
    expect(mhtml).toMatch(/boundary="----keelson-[0-9a-f]{16}"/);
    await writeFile(file, mhtml);
    const page = await context.newPage();
    await page.goto(pathToFileURL(file).href);
    await expect(page.locator("h1").textContent()).resolves.toBe("Trail Runner 2");
    await expect(page.locator("#price").textContent()).resolves.toBe("$129.00");
    await page.close();
  });

  test("the HAR has the document and the XHR with its JSON body", () => {
    const har = JSON.parse(decode(item(capture, "har").bytes)) as Har;
    const urls = har.log.entries.map((e) => new URL(e.request.url).pathname);
    expect(urls).toEqual(["/product.html", "/api/product.json"]);
    const xhr = har.log.entries[1];
    expect(xhr?.response.status).toBe(200);
    expect(xhr?.response.headers).toContainEqual({
      name: "content-type",
      value: "application/json",
    });
    expect(JSON.parse(xhr?.response.content.text ?? "null")).toMatchObject({ sku: "TR2-BLU-10" });
    expect(JSON.stringify(har)).not.toMatch(/"(time|timings|startedDateTime|cookies)"/);
  });

  test("the AX tree and DOM carry no per-capture ids", () => {
    const ax = decode(item(capture, "ax.tree").bytes);
    const dom = decode(item(capture, "dom.snapshot").bytes);
    expect(ax).not.toMatch(/nodeId|backendDOMNodeId|childIds|frameId|InlineTextBox/);
    expect(ax).toContain('"name":"Trail Runner 2"');
    expect(dom).not.toContain("backend");
  });

  test("pinned salts give the same root on a second load; fresh salts only change the leaves", async () => {
    const salts = Array.from({ length: 9 }, () => crypto.getRandomValues(new Uint8Array(32)));
    const a = await captureProduct(salts);
    const b = await captureProduct(salts);
    const hashes = (c: Capture) => c.manifest.items.map((i) => `${i.type}:${i.content_hash}`);
    expect(hashes(b)).toEqual(hashes(a));
    expect(b.manifest.root).toBe(a.manifest.root);

    const c = await captureProduct();
    expect(c.manifest.root).not.toBe(a.manifest.root);
    expect(hashes(c)).toEqual(hashes(a));
    for (const k of ["screenshot", "domSnapshot", "ax", "mhtml", "har", "total"]) {
      expect(a.timings[k]).toBeGreaterThanOrEqual(0);
    }
  });
});
