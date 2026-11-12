import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { type PreviewServer, preview } from "vite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { encodeAlibi, encodeAny, statementOf } from "../../../../packages/alibi/src/codec.ts";
import { fixtures } from "../../../../packages/alibi/test/fixtures.ts";
import { receipts } from "../../../../packages/alibi/test/log-receipts.ts";
import { v2Bundle } from "../../../../packages/alibi/test/v2.ts";

const VERIFY_ORIGIN = "https://verify.keelson.finance";
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

  test("a real Alibi: Cedar replays its policy evaluation and the fields say who answers", async () => {
    const { page, origins } = await open();
    const f = fixtures.find((x) => x.mode === "2of2");
    await drop(page, `${f?.id}.alibi`, "application/json", Buffer.from(f?.bytes ?? []));
    await verdict(page);
    const status = (id: string) =>
      page.locator(`[data-check="${id}"] [data-status]`).getAttribute("data-status");
    expect(await status("policy.replay")).toBe("pass");
    expect(await status("mandate.passkey")).toBe("pass");
    const answers = (id: string) =>
      page.locator(`[data-field="${id}"] [data-answers]`).textContent();
    expect(await answers("amount")).toBe("Keelson");
    expect(await answers("variant")).toBe("Agent operator");
    expect([...origins].every((o) => ALLOWED.has(o))).toBe(true);
    await page.close();
  });

  test("a C1 proof verifies with bb.js in the page and with the deployed verifier", async () => {
    const vector = JSON.parse(
      readFileSync(
        new URL("../../../../contracts/test/vectors/c1-proof.json", import.meta.url),
        "utf8",
      ),
    ) as { proof: string; publicInputs: string[] };
    const [cm, amount, currency, category, merchant, now, cart, operator] = vector.publicInputs as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const f = fixtures.find((x) => x.mode === "2of2");
    const b = structuredClone(f?.bundle) as NonNullable<typeof f>["bundle"];
    // The demo statement in place of the fixture's: its signatures fail, its proof stands alone.
    Object.assign(b.tee.countersign, {
      mandateCommitment: cm,
      amount: BigInt(amount).toString(),
      currency: BigInt(currency).toString(),
      category: BigInt(category).toString(),
      merchantId: merchant,
      issuedAt: BigInt(now).toString(),
      cartHash: cart,
      agentId: BigInt(operator).toString(),
    });
    b.zk = {
      c1: {
        proof: Buffer.from(vector.proof.slice(2), "hex").toString("base64"),
        public_inputs: vector.publicInputs,
      },
    };
    const { page, origins } = await open();
    await drop(page, "c1.alibi", "application/json", Buffer.from(encodeAlibi(b)));
    await verdict(page);
    const check = page.locator('[data-check="zk.c1"] [data-status]');
    expect(await check.getAttribute("data-status")).toBe("pass");
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

  test("embedded, a live receipt fails every cheat that applies to it and names the field", async () => {
    // A sandbox purchase's Alibi in log.keelson.finance/alibi/2026-1, anchored on Arbitrum Sepolia.
    const link = `${VERIFY_ORIGIN}/a/01M71DB3MZAX38NGP3NM8F48T6#PEcnLYqWw5d91wlYjOVd5sYkUkqz2uQJ-k6TBE0t5h0.758.421614`;
    const page = await browser.newPage();
    // The API answers CORS for the verifier's origin, so the build is served under it.
    await page.route(`${VERIFY_ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({
        url: new URL(`${url.pathname}${url.search}`, base).href,
      });
      await route.fulfill({ response });
    });
    await page.goto(link.replace("#", "?embed#"));
    await page.getByText("Public receipt verified").waitFor({ timeout: 30_000 });
    expect(await page.locator("[data-testid=file]").count()).toBe(0);
    expect(await page.getByLabel("RPC URL").count()).toBe(0);
    const presets = await page
      .locator("[data-preset]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-preset")));
    expect(presets).toEqual(["swap-cart", "blame-agent", "fake-anchor"]);
    for (const [preset, pointer] of [
      ["swap-cart", "/leaf/cart_hash"],
      ["blame-agent", "/leaf/agent_id"],
      ["fake-anchor", "/anchor/anchored_root"],
    ] as const) {
      await page.locator(`[data-preset=${preset}]`).click();
      await page.locator("[data-verdict=failed]").waitFor();
      expect(await page.locator("[data-check]", { hasText: pointer }).count()).toBeGreaterThan(0);
      await page.getByRole("button", { name: "Reset to the original" }).click();
      await page.getByText("Public receipt verified").waitFor();
    }
    const full = page.getByRole("link", { name: "Open in the full verifier" });
    expect(await full.getAttribute("href")).toBe(link);
    await page.close();
  });

  test("opened from a receipt link, the page keeps its shape while the receipt loads", async () => {
    const link = `${VERIFY_ORIGIN}/a/01M71DB3MZAX38NGP3NM8F48T6#PEcnLYqWw5d91wlYjOVd5sYkUkqz2uQJ-k6TBE0t5h0.758.421614`;
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 412, height: 915 },
    ]) {
      const page = await browser.newPage({ viewport });
      await page.route(`${VERIFY_ORIGIN}/**`, async (route) => {
        const url = new URL(route.request().url());
        const response = await route.fetch({
          url: new URL(`${url.pathname}${url.search}`, base).href,
        });
        await route.fulfill({ response });
      });
      await page.addInitScript(() => {
        const w = window as unknown as { cls: number };
        w.cls = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as unknown as { value: number }[]) w.cls += e.value;
        }).observe({ type: "layout-shift", buffered: true });
      });
      await page.goto(link);
      await page.getByText("Public receipt verified").waitFor({ timeout: 30_000 });
      const cls = await page.evaluate(() => (window as unknown as { cls: number }).cls);
      expect(cls).toBeLessThan(0.1);
      await page.close();
    }
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

  test("a composed anonymous proof verifies in the page and on chain, bound to the receipt", async () => {
    const page = await browser.newPage();
    // Served from its own origin, the one the API lets read receipts and proofs.
    await page.route(`${VERIFY_ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({
        url: new URL(`${url.pathname}${url.search}`, base).href,
      });
      await route.fulfill({ response });
    });
    const origins = new Set<string>();
    page.on("request", (r) => origins.add(new URL(r.url()).origin));
    const started = Date.now();
    await page.goto(`${VERIFY_ORIGIN}/a/01M73AGWP5EJSW35XE6Q090MCH?proof=anonymous`);
    await page.locator("[data-anonymous=pass]").waitFor({ timeout: 30_000 });
    const elapsed = Date.now() - started;
    const steps = page.locator("[data-anon-step] [data-status]");
    expect(await steps.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))).toEqual(
      ["pass", "pass", "pass", "pass"],
    );
    await page.getByText("125 registered users").first().waitFor();
    await page.getByText("$1.00").waitFor();
    expect(elapsed).toBeLessThan(15_000);
    origins.delete(VERIFY_ORIGIN);
    expect([...origins].every((o) => ALLOWED.has(o))).toBe(true);
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

describe("a v2 Alibi in Chromium", () => {
  // The golden statement's receipt is signed with a test key no verifier pins, and its legs are
  // test keys: those rows fail by design; the rest hold offline.
  const b = v2Bundle();
  const tone = (page: Page, key: string) =>
    page.locator(`[data-standard="${key}"]`).getAttribute("data-tone");

  test("the standards panel shows each artifact, offline, and its files download", async () => {
    const { page } = await open();
    await page.route("**", (route) =>
      new URL(route.request().url()).origin === new URL(base).origin
        ? route.continue()
        : route.abort(),
    );
    await drop(page, `${b.alibi_id}.alibi`, "application/json", Buffer.from(encodeAny(b)));
    await verdict(page);
    await page.locator("[data-standard]").first().waitFor();
    expect(await page.locator("[data-standard]").count()).toBe(6);
    expect(await tone(page, "statement")).toBe("pass");
    expect(await tone(page, "evidence")).toBe("pass");
    expect(await tone(page, "receipt")).toBe("fail");

    const [statement] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download statement" }).click(),
    ]);
    expect(statement.suggestedFilename()).toBe(`${b.alibi_id}.cose`);
    expect(new Uint8Array(readFileSync((await statement.path()) as string))).toEqual(
      statementOf(b),
    );

    const [ear] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download results" }).click(),
    ]);
    const claims = JSON.parse(readFileSync((await ear.path()) as string, "utf8"));
    expect(claims.eat_profile).toBe("tag:ietf.org,2026:rats/ear#05");
    await page.close();
  });

  test("a tampered .cose fails the signed statement", async () => {
    const { page } = await open();
    const cose = Buffer.from(statementOf(b));
    cose.writeUInt8((cose.at(-1) as number) ^ 1, cose.length - 1);
    await drop(page, `${b.alibi_id}.cose`, "application/scitt-statement+cose", cose);
    await verdict(page);
    expect(await tone(page, "statement")).toBe("fail");
    await page.close();
  });

  test("a dropped standards export is checked in the page, offline, against its statement", async () => {
    const { exportAcp, purchaseFacts } = await import("@keelson/interop");
    const { ALLOW_PAYPAL, alibi, NOW, testIssuer } = await import(
      "../../../../packages/interop/test/fixtures.ts"
    );
    const { v2Ref } = await import("../../../../packages/interop/test/v2.ts");
    const x = await exportAcp(
      purchaseFacts(alibi(ALLOW_PAYPAL)),
      v2Ref("allow-2of2"),
      {
        issuer: await testIssuer(ALLOW_PAYPAL),
      },
      { now: NOW },
    );
    const { page, origins } = await open();
    const before = origins.size;
    await drop(
      page,
      `${ALLOW_PAYPAL}.acp.json`,
      "application/json",
      Buffer.from(JSON.stringify(x)),
    );
    const report = page.getByRole("region", { name: /Export (not )?verified/ });
    await report.waitFor();
    // The test issuer and receipt keys are not the pinned production ones.
    expect(await report.getByRole("heading").textContent()).toBe("Export not verified");
    expect(await report.getByText("The log's receipt includes that statement").count()).toBe(1);
    expect(await report.getByText(/nothing was sent/).count()).toBe(1);
    expect(origins.size).toBe(before);
    await page.close();
  });

  test("a v1 Alibi shows no standards panel", async () => {
    const { page } = await open();
    const f = fixtures.find((x) => x.mode === "2of2");
    await drop(page, `${f?.id}.alibi`, "application/json", Buffer.from(f?.bytes ?? []));
    await verdict(page);
    expect(await page.locator("[data-standard]").count()).toBe(0);
    await page.close();
  });
});
