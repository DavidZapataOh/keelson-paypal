import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { type Browser, chromium, type Frame, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildView } from "../scripts/build-view.ts";

// The View under the official host side of MCP Apps (`AppBridge` over `PostMessageTransport`),
// in a sandboxed iframe as hosts render it.

const card = {
  purchaseId: "01M725SRGK6SS7HEXN1K572KJY",
  state: "CAPTURED",
  amount: { currency: "USD", minor: 13900 },
  mode: "2of2",
  decision: "allow",
  merchant: "mrc_runfast",
  items: [{ sku: "RF-TRL2-10", size: "10" }],
  fields: [
    { id: "amount", field: "total", liability: "verified", pass: true },
    { id: "category", field: "category", liability: "attested", pass: true },
    { id: "returns", field: "return_policy", liability: "yours", pass: true },
  ],
  logIndex: "771",
  timestamps: 2,
  anchor: { chainId: 421614, txHash: `0x${"ab".repeat(32)}`, blockNumber: "220000000" },
  capture: { id: "4KX12345AB678901C", status: "COMPLETED" },
  failure: null,
  verifyUrl: "https://verify.keelson.finance/a/01M725SRGK6SS7HEXN1K572KJY#x.0.421614",
  issuedAt: "2026-11-10T07:30:00Z",
};

const HOST = `
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
const iframe = document.createElement("iframe");
iframe.sandbox = "allow-scripts";
iframe.style.cssText = "width:560px;height:640px;border:0";
document.body.append(iframe);
window.startHost = async (html, theme, result) => {
  const bridge = new AppBridge(null, { name: "test-host", version: "1.0.0" }, { openLinks: {}, serverTools: {} }, { hostContext: { theme } });
  bridge.oncalltool = (params) => window.callTool(params);
  bridge.onopenlink = async (params) => { await window.openLink(params.url); return {}; };
  bridge.onsizechange = (size) => { window.lastSize = size; };
  bridge.oninitialized = () => {
    bridge.sendToolInput({ arguments: { purchaseId: result.structuredContent.purchaseId } });
    bridge.sendToolResult(result);
  };
  iframe.srcdoc = html;
  await new Promise((r) => iframe.addEventListener("load", r, { once: true }));
  await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
};`;

let browser: Browser;
let html: string;
let origin: string;
const server = createServer();

beforeAll(async () => {
  html = await buildView();
  const host = await build({
    stdin: { contents: HOST, resolveDir: import.meta.dirname, loader: "js" },
    bundle: true,
    format: "esm",
    write: false,
  });
  const page = `<!doctype html><body><script type="module">${host.outputFiles[0]?.text}</script></body>`;
  server.on("request", (_, res) => res.writeHead(200, { "content-type": "text/html" }).end(page));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  server.close();
});

async function open(
  theme: "light" | "dark",
): Promise<{ page: Page; view: Frame; calls: unknown[]; links: string[] }> {
  const page = await browser.newPage();
  const calls: unknown[] = [];
  const links: string[] = [];
  await page.exposeFunction("callTool", (params: unknown) => {
    calls.push(params);
    return {
      content: [{ type: "text", text: "verified" }],
      structuredContent: {
        verdict: "verified",
        checks: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, status: "pass" })),
        verifyUrl: card.verifyUrl,
      },
    };
  });
  await page.exposeFunction("openLink", (url: string) => {
    links.push(url);
  });
  await page.goto(origin);
  await page.evaluate(
    ([h, t, c]) =>
      (window as unknown as { startHost(...a: unknown[]): Promise<void> }).startHost(h, t, {
        content: [{ type: "text", text: "card" }],
        structuredContent: c,
      }),
    [html, theme, card] as const,
  );
  const view = page.frames()[1] as Frame;
  await view.waitForSelector("#alibi:not([aria-busy])");
  return { page, view, calls, links };
}

test("the View renders the Alibi a tool result carries", async () => {
  const { page, view } = await open("light");
  const text = await view.locator("#alibi").textContent();
  expect(text).toContain("$139.00");
  expect(text).toContain("Countersigned");
  expect(text).toContain("RF-TRL2-10 · 10");
  expect(text).toContain("Arbitrum Sepolia · block 220000000");
  expect(await view.locator(".fields li").count()).toBe(3);
  expect(await view.locator(".mark.verified").getAttribute("aria-label")).toBe("Keelson-verified");
  const act = await view.locator(".chip.act").evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(act).toBe("rgb(255, 75, 31)");
  await page.close();
});

test("the View follows the host's theme", async () => {
  const { page, view } = await open("dark");
  const bg = await view.locator(".card").evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(bg).toBe("rgb(31, 32, 36)");
  await page.close();
});

test("Verify calls keelson.verify_alibi through the host, and the verifier opens through it", async () => {
  const { page, view, calls, links } = await open("light");
  await view.getByRole("button", { name: "Verify" }).click();
  await expect
    .poll(() => view.locator(".verdict").textContent())
    .toBe("Verified: 9 of 9 checks pass.");
  expect(calls).toEqual([
    { name: "keelson.verify_alibi", arguments: { purchaseId: card.purchaseId } },
  ]);
  await view.getByRole("button", { name: "Open verifier ↗" }).click();
  await expect.poll(() => links).toEqual([card.verifyUrl]);
  const size = await page.evaluate(
    () => (window as unknown as { lastSize?: { height: number } }).lastSize,
  );
  expect(size?.height).toBeGreaterThan(200);
  await page.close();
});

test("the View stays small", () => {
  expect(Buffer.byteLength(html)).toBeLessThan(16 * 1024);
});
