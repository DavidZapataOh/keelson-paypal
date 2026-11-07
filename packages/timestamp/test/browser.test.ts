import { jcs } from "@keelson/core";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { bundleTimestamp } from "../scripts/bundle.ts";
import { verifyTimestamp } from "../src/verify.ts";
import { imprint, tokens } from "./tokens.ts";

let browser: Browser;
let bundle: Awaited<ReturnType<typeof bundleTimestamp>>;

beforeAll(async () => {
  bundle = await bundleTimestamp();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

test("the browser returns what Node returns for the same tokens", async () => {
  const inNode = await Promise.all(
    Object.values(tokens).map((token) => verifyTimestamp(token, imprint)),
  );

  const page = await browser.newPage();
  await page.route("http://localhost/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("http://localhost/");
  await page.addScriptTag({ content: bundle.code });
  const inBrowser = await page.evaluate(
    async ([hexTokens, hexImprint]) => {
      const bytes = (hex: string) =>
        Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
      const api = (
        globalThis as unknown as {
          timestamp: { verifyTimestamp: (t: Uint8Array, i: Uint8Array) => Promise<unknown> };
        }
      ).timestamp;
      return Promise.all(hexTokens.map((t) => api.verifyTimestamp(bytes(t), bytes(hexImprint))));
    },
    [Object.values(tokens).map(bytesToHex), bytesToHex(imprint)] as const,
  );
  await page.close();

  expect(jcs(JSON.parse(JSON.stringify(inBrowser)))).toBe(jcs(JSON.parse(JSON.stringify(inNode))));
  console.info(`bundle: ${bundle.bytes} B minified, ${bundle.gzip} B gzip`);
});
