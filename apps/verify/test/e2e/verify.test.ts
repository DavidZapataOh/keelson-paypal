import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { type PreviewServer, preview } from "vite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { receipts } from "../../../../packages/alibi/test/log-receipts.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const outDir = fileURLToPath(new URL("../../dist", import.meta.url));
const ALLOWED = new Set([
  "https://api.keelson.finance",
  "https://log.keelson.finance",
  "https://sepolia-rollup.arbitrum.io",
  "https://arbitrum-sepolia-rpc.publicnode.com",
]);

// Previews the production build, which turbo runs before the tests.
let server: PreviewServer;
let browser: Browser;
let base: string;

beforeAll(async () => {
  server = await preview({ root, logLevel: "silent", build: { outDir }, preview: { port: 0 } });
  base = server.resolvedUrls?.local[0] as string;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** A page that records the origin of every request it makes. */
async function open(): Promise<{ page: Page; origins: Set<string> }> {
  const page = await browser.newPage();
  const origins = new Set<string>();
  page.on("request", (r) => {
    const o = new URL(r.url()).origin;
    if (o !== new URL(base).origin && o !== "null") origins.add(o);
  });
  await page.goto(base);
  return { page, origins };
}

/** Drops a file; through disk, since Playwright passes at most 50 MB in memory. */
const drop = (page: Page, name: string, mimeType: string, buffer: Buffer) => {
  if (buffer.length < 1024 * 1024) {
    return page.setInputFiles("[data-testid=file]", { name, mimeType, buffer });
  }
  const path = join(tmpdir(), name);
  writeFileSync(path, buffer);
  return page.setInputFiles("[data-testid=file]", path);
};

const verdict = async (page: Page) => {
  const el = page.locator("[data-verdict]:not([data-verdict=running])");
  await el.waitFor({ timeout: 30_000 });
  return el.getAttribute("data-verdict");
};

const receipt = Buffer.from(JSON.stringify(receipts[0]));

describe("the verifier in Chromium", () => {
  test("a real receipt: the log verifies, the rest is not disclosed", async () => {
    const { page, origins } = await open();
    await drop(page, "receipt.json", "application/json", receipt);
    await verdict(page);
    await page.getByText("Public receipt verified").waitFor();
    const status = (id: string) =>
      page.locator(`[data-check="${id}"] [data-status]`).getAttribute("data-status");
    expect(await status("log.inclusion")).toBe("pass");
    expect(await status("log.witnesses")).toBe("pass");
    expect(await status("mandate.passkey")).toBe("undisclosed");
    // Read from the chain under the site's CSP: pending (not anchored in this receipt), not unreachable.
    expect(await status("anchor.root")).toBe("pending");
    expect([...origins].every((o) => ALLOWED.has(o))).toBe(true);
    await page.close();
  });

  test("an edit of the local copy fails and names the field, and reset restores it", async () => {
    const { page, origins } = await open();
    const posted: string[] = [];
    page.on("request", (r) => posted.push(r.postData() ?? ""));
    await drop(page, "receipt.json", "application/json", receipt);
    await verdict(page);
    await page.locator("summary", { hasText: "leaf" }).first().click();
    const input = page.locator('[data-pointer="/leaf/cart_hash"]');
    const value = await input.inputValue();
    await input.fill(`${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`);
    await input.press("Enter");
    await page.locator("[data-verdict=failed]").waitFor();
    expect(await page.locator('[data-check="log.inclusion"]').textContent()).toContain(
      "/leaf/cart_hash",
    );
    await page.getByRole("button", { name: "Reset to the original" }).click();
    await page.locator("[data-verdict=incomplete]").waitFor();
    expect(posted.some((b) => b.includes(receipts[0]?.alibi_id as string))).toBe(false);
    expect([...origins].every((o) => ALLOWED.has(o))).toBe(true);
    await page.close();
  });

  test.each([
    ["a 50 MB file", "big.json", "application/json", Buffer.alloc(50 * 1024 * 1024, 0x20), /8 MB/],
    [
      "a PDF without an embedded Alibi",
      "empty.pdf",
      "application/pdf",
      Buffer.from(
        "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
      ),
      /no Alibi/,
    ],
    ["prototype keys", "p.json", "application/json", Buffer.from('{"__proto__":{}}'), /__proto__/],
    [
      "deep nesting",
      "d.json",
      "application/json",
      Buffer.from(`${"[".repeat(10_000)}${"]".repeat(10_000)}`),
      /deeply/,
    ],
  ])("%s is refused with a message", async (_, name, mime, buffer, message) => {
    const { page, origins } = await open();
    await drop(page, name, mime, buffer);
    expect(await page.getByRole("alert").textContent()).toMatch(message);
    expect(origins.size).toBe(0);
    await page.close();
  });

  test("an http or javascript RPC is refused", async () => {
    for (const rpc of ["http://example.com", "javascript:alert(1)"]) {
      const page = await browser.newPage();
      await page.goto(`${base}?rpc=${encodeURIComponent(rpc)}`);
      await page.getByLabel("RPC URL").fill(rpc);
      await page.getByRole("button", { name: "Use this RPC" }).click();
      expect(await page.getByRole("alert").textContent()).toContain("https");
      await page.close();
    }
  });
});
