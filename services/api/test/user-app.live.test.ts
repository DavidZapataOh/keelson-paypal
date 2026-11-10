import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import AxeBuilder from "@axe-core/playwright";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { cartHash } from "@keelson/core";
import { eq, mandates, operators, purchases } from "@keelson/db";
import { closeMandate } from "@keelson/mandate";
import { approveOnPage } from "@keelson/paypal/testing";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import type { MiddlewareHandler } from "hono";
import { type Browser, chromium, devices, type Page } from "playwright";
import { ulid } from "ulid";
import { bytesToHex } from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CSP } from "../../../apps/web/csp.ts";
import { createAuth } from "../src/auth.ts";
import { operatorAgent, termsConsent } from "../src/compile-sources.ts";
import { authenticate } from "../src/middleware/auth.ts";
import { engineSource } from "../src/tee/engine-source.ts";
import { APP_ORIGIN } from "./hold-live.ts";
import { AGENT_ID, cartOf } from "./pipeline-live.ts";
import { pipelineHarness } from "./purchase-live.ts";
import { testAuthEnv, testDb } from "./setup.ts";
import { asAgent, headerPrincipal, live, repeating } from "./tee-live.ts";

const API_ORIGIN = "https://api.keelson.finance";
// The app's static export, built before this suite (`pnpm --filter @keelson/web build`).
const out = fileURLToPath(new URL("../../../apps/web/out", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

async function file(path: string): Promise<string | undefined> {
  for (const candidate of [path, join(path, "index.html")]) {
    if ((await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  return undefined;
}

/** Interaction latencies of the page, from the Event Timing API: the worst is its INP. */
const watchInteractions = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { durations: number[] };
    w.durations = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEventTiming[]) {
        if (e.interactionId) w.durations.push(e.duration);
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

describe.skipIf(!live)("the user app, first-time user (live sandbox)", { timeout: 600_000 }, () => {
  const secret = "user-app-live-secret-0123456789abcdef";
  const auth = createAuth(testDb, { ...testAuthEnv(API_ORIGIN, secret), APP_ORIGIN });
  const session = authenticate(auth, API_ORIGIN);
  // The pages sign in with the session cookie; the harness acts as the agent with a test header.
  const principal: MiddlewareHandler = (c, next) =>
    c.req.header("x-test-principal") ? headerPrincipal(c, next) : session(c, next);
  const helpers = betterAuth({
    database: drizzleAdapter(testDb, { provider: "pg" }),
    secret,
    baseURL: API_ORIGIN,
    plugins: [testUtils()],
  });

  let harness!: Awaited<ReturnType<typeof pipelineHarness>>;
  let agentKey!: CryptoKey;
  let browser!: Browser;

  beforeAll(async () => {
    harness = await pipelineHarness({
      auth,
      authenticate: principal,
      anthropic: new Anthropic(),
      compileSources: {
        engine: engineSource,
        consent: termsConsent,
        agent: operatorAgent(testDb, AGENT_ID),
      },
    });
    // The demo operator's agent: this suite holds its key and checks out as it.
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    agentKey = pair.privateKey;
    const { x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
    await testDb
      .update(operators)
      .set({ cnfJwk: { kty: "EC", crv: "P-256", x, y } })
      .where(eq(operators.agentId, AGENT_ID));
    browser = await chromium.launch({
      channel: "chromium",
      args: ["--enable-features=SecurePaymentConfirmationBrowser"],
    });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await harness?.close();
  });

  for (const [device, options] of [
    ["Chrome desktop", { viewport: { width: 1280, height: 860 } }],
    ["Chrome on Android (Pixel 7)", devices["Pixel 7"]],
  ] as const) {
    test(`${device}: sign in, passkey, mandate, PayPal hold, a live purchase and its Alibi`, async () => {
      const { test: utils } = await helpers.$context;
      const user = await utils.saveUser(utils.createUser());
      const context = await browser.newContext({ ...options, locale: "en-US" });
      await context.addCookies(
        await utils.getCookies({ userId: user.id, domain: "api.keelson.finance" }),
      );
      // The app and the API keep their production origins: this process answers both, and every
      // PayPal, engine and chain request goes out.
      await context.route(`${APP_ORIGIN}/**`, async (route) => {
        const path = await file(join(out, new URL(route.request().url()).pathname));
        if (!path) return route.fulfill({ status: 404 });
        return route.fulfill({
          contentType: TYPES[extname(path)] ?? "application/octet-stream",
          headers: { "content-security-policy": CSP },
          body: await readFile(path),
        });
      });
      await context.route(`${API_ORIGIN}/**`, async (route) => {
        const req = route.request();
        const body = req.postDataBuffer();
        // The browser's address, as the Node server reads it from the socket.
        const res = await harness.app.request(
          req.url(),
          {
            method: req.method(),
            headers: await req.allHeaders(),
            ...(body ? { body: new Uint8Array(body) } : {}),
          },
          {
            incoming: {
              socket: { remoteAddress: "127.0.0.1", remotePort: 0, remoteFamily: "IPv4" },
            },
          },
        );
        if (res.headers.get("content-type")?.startsWith("text/event-stream")) {
          // Playwright fulfils whole bodies, so the stream is read until the page has what it needs.
          const reader = res.body?.getReader();
          let text = "";
          const deadline = Date.now() + 1_500;
          while (reader && Date.now() < deadline) {
            const chunk = await Promise.race([
              reader.read(),
              new Promise<undefined>((r) => setTimeout(r, deadline - Date.now())),
            ]);
            if (!chunk || chunk.done) break;
            text += new TextDecoder().decode(chunk.value);
          }
          await reader?.cancel();
          return route.fulfill({
            status: res.status,
            headers: Object.fromEntries(res.headers),
            body: text,
          });
        }
        return route.fulfill({
          status: res.status,
          headers: Object.fromEntries(res.headers),
          body: Buffer.from(await res.arrayBuffer()),
        });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(60_000);
      await watchInteractions(page);
      const cdp = await context.newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      await cdp.send("Page.setSPCTransactionMode", { mode: "autoAccept" });
      let shot = 0;
      const axe = async () => {
        // SCREENSHOTS names a directory to keep each checked screen, for design review.
        if (process.env.SCREENSHOTS) {
          await page.screenshot({
            path: join(
              process.env.SCREENSHOTS,
              `${device.includes("Android") ? "mobile" : "desktop"}-${++shot}.png`,
            ),
            fullPage: true,
          });
        }
        const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`)).toEqual(
          [],
        );
      };

      try {
        await page.goto(`${APP_ORIGIN}/`);
        await page.getByRole("heading", { name: "Nothing is delegated yet" }).waitFor();
        await axe();

        await page.getByRole("link", { name: "New mandate" }).first().click();
        await page.getByRole("button", { name: "Create passkey" }).click();
        await page.getByRole("heading", { name: "What may your agent buy?" }).waitFor();
        await axe();
        await page.getByRole("button", { name: "Use the example" }).click();
        await page.getByRole("button", { name: "Review the mandate" }).click();
        await page.getByRole("heading", { name: "Check it, then sign" }).waitFor();
        const review = page.getByRole("button", { name: "Review and sign" });
        await expect.poll(() => review.isEnabled(), { timeout: 60_000 }).toBe(true);
        await axe();
        await review.click();
        // The grant is said once more, with Cancel as weighty as the act and the cap on the button.
        await page.getByRole("dialog", { name: "Sign this mandate" }).waitFor();
        expect(await page.getByRole("button", { name: "Cancel" }).isVisible()).toBe(true);
        await axe();
        await page.getByRole("button", { name: "Sign: allow up to $100.00" }).click();
        await page.waitForURL(/\/mandate\/\?id=/);
        const mid = new URL(page.url()).searchParams.get("id") as string;

        await page.getByRole("heading", { name: "Approve the hold on PayPal" }).waitFor();
        await page.locator("paypal-button").waitFor();
        await axe();
        const popup = context.waitForEvent("page", { timeout: 20_000 });
        await page.locator("paypal-button").click();
        const paypal = await popup;
        paypal.setDefaultTimeout(60_000);
        await paypal.waitForLoadState();
        await approveOnPage(paypal);
        await page.getByText(/· Active$/).waitFor({ timeout: 90_000 });

        // The agent checks out a cart inside the mandate; the page shows it live.
        const [row] = await testDb.select().from(mandates).where(eq(mandates.id, mid));
        if (!row?.openMandate || !row.paypalAuthorizationId) throw new Error("mandate not active");
        const requestId = ulid();
        const cart = cartOf(4_000);
        const res = await harness.app.request("/v1/countersign", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": ulid(), ...asAgent },
          body: JSON.stringify({
            authorizationId: row.paypalAuthorizationId,
            closedMandate: await closeMandate(
              row.openMandate,
              { requestId, cartHash: `sha256:${bytesToHex(cartHash(cart.cart)).slice(2)}` },
              agentKey,
            ),
            cart: cart.cart,
            unit: cart.unit,
            evidenceRoot: await harness.evidence.upload(harness.app, mid, cart.cart, asAgent),
            ...(await repeating(testDb, mid, cart.cart, requestId)),
          }),
        });
        const countersigned = (await res.json()) as { purchaseId?: string };
        console.info(
          `${device} countersign ${res.status}: ${JSON.stringify(countersigned).slice(0, 300)}`,
        );
        expect([200, 202], JSON.stringify(countersigned)).toContain(res.status);

        // The purchase arrives on the open page over SSE, with Keelson's decision.
        await page.getByRole("link", { name: /\$40\.00/ }).waitFor({ timeout: 60_000 });
        await axe();
        await page.getByRole("link", { name: /\$40\.00/ }).click();
        await page.getByRole("heading", { name: "Alibi" }).waitFor();
        await page.getByText("Keelson countersigned the cart").waitFor();
        await axe();
        // Issuing the Alibi checks the log's witness cosignatures. The local log here has no
        // witnesses, so its leaf fails that check and the purchase stops before capture; the page
        // must say so. Against the deployed log the same page links the verifier and the PDF.
        const [p] = await testDb.select().from(purchases).where(eq(purchases.mandateId, mid));
        if (p?.state === "CAPTURED") {
          const verify = page.getByRole("link", { name: "Verify in your browser" });
          expect(await verify.getAttribute("href")).toMatch(
            /^https:\/\/verify\.keelson\.finance\/a\/[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
          );
          const download = page.waitForEvent("download");
          await page.getByRole("button", { name: "Download PDF" }).click();
          expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
        } else {
          expect(p?.failureReason).toBe("alibi:verify");
          await page.getByText("Stopped at alibi: nothing was captured").waitFor();
          await page.getByText("No Alibi was issued for this cart (stopped at alibi).").waitFor();
        }
        console.info(`${device} purchase ${p?.id}: ${p?.state} ${p?.failureReason ?? ""}`);

        const inp = await page.evaluate(() =>
          Math.max(0, ...(window as unknown as { durations: number[] }).durations),
        );
        console.info(JSON.stringify({ device, mandate: mid, inpMs: Math.round(inp) }));
        expect(inp).toBeLessThan(150);
      } catch (err) {
        const alerts = await page
          .getByRole("alert")
          .allTextContents()
          .catch(() => []);
        if (alerts.length > 0) console.error(`${device} alerts: ${alerts.join(" | ")}`);
        throw err;
      } finally {
        await context.close();
      }
    });
  }
});
