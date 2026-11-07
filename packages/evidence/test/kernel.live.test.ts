import Kernel from "@onkernel/sdk";
import { generateHybridIdentity, identityToRecipient } from "age-encryption";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type Capture,
  captureEvidence,
  type Recorder,
  startRecorder,
} from "../src/capture/index.ts";
import { disclose, ITEM_TYPES, verifyDisclosure } from "../src/index.ts";
import { routePages } from "./server.ts";

const live = process.env.KEELSON_LIVE === "1" && !!process.env.KERNEL_API_KEY;
const ORIGIN = "https://store.keelson.test";

describe.skipIf(!live)("capture on a KERNEL browser over CDP", { timeout: 120_000 }, () => {
  const kernel = new Kernel();
  let session: string | undefined;
  let browser: Browser;
  let page: Page;
  let recorder: Recorder;
  let capture: Capture;

  beforeAll(async () => {
    const created = await kernel.browsers.create({
      headless: true,
      timeout_seconds: 300,
    });
    session = created.session_id;
    browser = await chromium.connectOverCDP(created.cdp_ws_url);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    await routePages(context, ORIGIN);
    page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });
    recorder = await startRecorder(page);
    await page.goto(`${ORIGIN}/attack.html`);
    await page.locator("body[data-ready]").waitFor({ state: "attached" });
    const recipient = await identityToRecipient(await generateHybridIdentity());
    const llmObservation = await page.locator("body").ariaSnapshot();
    capture = await captureEvidence(recorder, { product: {}, cart: {}, llmObservation, recipient });
  });
  afterAll(async () => {
    await recorder?.stop();
    await browser?.close();
    if (session) await kernel.browsers.deleteByID(session);
  });

  test("the attack page captures with every item and a root that verifies", () => {
    expect(capture.manifest.items.map((i) => i.type)).toEqual([...ITEM_TYPES]);
    for (let k = 0; k < capture.items.length; k++) {
      expect(verifyDisclosure(capture.manifest.root, disclose(capture.items, k))).toBe(true);
    }
  });

  test("the six hidden injections are flagged and reached the agent", () => {
    expect(capture.findings).toHaveLength(6);
    for (const f of capture.findings) expect(f.reachedAgent).toBe(true);
  });

  test("the remote recorder saw the page's XHR and its body", () => {
    const xhr = recorder.requests.find((r) => r.url === `${ORIGIN}/api/product.json`);
    expect(xhr?.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(xhr?.body))).toMatchObject({ sku: "TR2-BLU-10" });
  });
});
