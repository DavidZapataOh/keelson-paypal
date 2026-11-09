import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { holdCustomId } from "@keelson/paypal";
import { approveOnPage } from "@keelson/paypal/testing";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { build } from "esbuild";
import type { MiddlewareHandler } from "hono";
import { pino } from "pino";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { authenticate } from "../src/middleware/auth.ts";
import { call } from "../src/paypal.ts";
import { APP_ORIGIN, holdHarness, row, sandbox } from "./hold-live.ts";
import { testAuthEnv, testDb, testKv } from "./setup.ts";
import { asUser, headerPrincipal, live } from "./tee-live.ts";

const API_ORIGIN = "https://api.keelson.finance";

const pageScript = `
import { approveHold, mandateHold } from "@keelson/paypal/browser";

const api = document.documentElement.dataset.api;
const mid = new URLSearchParams(location.search).get("mid");
const hold = mandateHold(api, mid);
window.keelson = { orders: [], events: [] };
window.keelson.status = await approveHold({
  api,
  container: document.body,
  currencyCode: "USD",
  createOrder: async () => {
    const order = await hold.createOrder();
    window.keelson.orders.push(order.orderId);
    return order;
  },
  authorize: async (orderId) => {
    await hold.authorize(orderId);
    window.keelson.events.push("authorized");
  },
  onCancel: () => window.keelson.events.push("cancel"),
  onError: (error) => window.keelson.events.push("error: " + String(error)),
});
`;

interface PageState {
  status?: "ready" | "ineligible";
  orders: string[];
  events: string[];
}

describe.skipIf(!live)("hold approval in the browser (live sandbox)", { timeout: 300_000 }, () => {
  const paypal = live ? sandbox() : (undefined as never);
  const secret = randomBytes(32).toString("base64url");
  const auth = createAuth(testDb, { ...testAuthEnv(API_ORIGIN, secret), APP_ORIGIN });
  const session = authenticate(auth, API_ORIGIN);
  // The page signs in with the session cookie; the harness itself calls with a test header.
  const principal: MiddlewareHandler = (c, next) =>
    c.req.header("x-test-principal") ? headerPrincipal(c, next) : session(c, next);
  const app = createApp({
    db: testDb,
    kv: testKv,
    log: pino({ level: "silent" }),
    auth,
    appOrigin: APP_ORIGIN,
    authenticate: principal,
    paypal,
    requestTimeoutMs: 60_000,
  });
  const { signed, release } = holdHarness(app, paypal);
  const helpers = betterAuth({
    database: drizzleAdapter(testDb, { provider: "pg" }),
    secret,
    baseURL: API_ORIGIN,
    plugins: [testUtils()],
  });

  let clientJs = "";
  let browser!: Browser;

  beforeAll(async () => {
    const bundle = await build({
      stdin: {
        contents: pageScript,
        resolveDir: fileURLToPath(new URL("..", import.meta.url)),
        loader: "js",
      },
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      logLevel: "error",
    });
    clientJs = bundle.outputFiles[0]?.text ?? "";
    browser = await chromium.launch({ headless: process.env.PLAYWRIGHT_HEADED !== "1" });
  });

  afterAll(async () => {
    await browser?.close();
  });

  /**
   * The app page for `mid`, signed in as `sub`. The app and the API keep their production
   * origins: Playwright answers both from this process, and every PayPal request goes out.
   */
  async function appPage(
    sub: string,
    mid: string,
  ): Promise<{ context: BrowserContext; page: Page }> {
    const { test: utils } = await helpers.$context;
    const context = await browser.newContext({ locale: "en-US" });
    await context.addCookies(
      await utils.getCookies({ userId: sub, domain: "api.keelson.finance" }),
    );
    await context.route(`${APP_ORIGIN}/**`, (route) =>
      new URL(route.request().url()).pathname === "/client.js"
        ? route.fulfill({ contentType: "text/javascript", body: clientJs })
        : route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html data-api="${API_ORIGIN}"><title>Keelson</title><script type="module" src="/client.js"></script></html>`,
          }),
    );
    await context.route(`${API_ORIGIN}/**`, async (route) => {
      const req = route.request();
      const body = req.postDataBuffer();
      const res = await app.request(req.url(), {
        method: req.method(),
        headers: await req.allHeaders(),
        ...(body ? { body: new Uint8Array(body) } : {}),
      });
      await route.fulfill({
        status: res.status,
        headers: Object.fromEntries(res.headers),
        body: Buffer.from(await res.arrayBuffer()),
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);
    await page.goto(`${APP_ORIGIN}/mandates/${mid}?mid=${mid}`);
    await page.waitForFunction("window.keelson?.status !== undefined");
    expect(await state(page)).toMatchObject({ status: "ready" });
    return { context, page };
  }

  const state = (page: Page) => page.evaluate<PageState>("window.keelson");

  /** Clicks the PayPal button and resolves to the window PayPal opened, recording the mode. */
  async function start(context: BrowserContext, page: Page): Promise<Page> {
    const opened = context.waitForEvent("page", { timeout: 15_000 });
    await page.locator("paypal-button").click();
    const popup = await opened.catch(() => undefined);
    console.info(`presentation mode: ${popup ? "popup" : `same page (${page.url()})`}`);
    if (!popup) throw new Error("PayPal did not open a popup");
    popup.setDefaultTimeout(45_000);
    await popup.waitForLoadState();
    return popup;
  }

  test("the buyer approves the hold in the PayPal popup and the mandate becomes ACTIVE", async () => {
    const { sub, mid, mandateHash } = await signed();
    const { context, page } = await appPage(sub, mid);
    let authorizationId: string | null | undefined;
    try {
      const popup = await start(context, page);
      await approveOnPage(popup);
      const consented = performance.now();
      await expect
        .poll(
          async () => {
            const res = await app.request(`/v1/mandates/${mid}`, { headers: asUser(sub) });
            return ((await res.json()) as { state: string }).state;
          },
          { timeout: 60_000, interval: 100 },
        )
        .toBe("ACTIVE");
      console.info(`consent click to ACTIVE: ${Math.round(performance.now() - consented)} ms`);

      const stored = await row(mid);
      authorizationId = stored?.paypalAuthorizationId;
      const { orders, events } = await state(page);
      expect(orders).toEqual([stored?.paypalOrderId]);
      expect(events).toEqual(["authorized"]);
      console.info(`order id: ${stored?.paypalOrderId}, authorization id: ${authorizationId}`);
      const authorization = await call(
        paypal.paypal.payments.getAuthorizedPayment({ authorizationId: authorizationId as string }),
      );
      expect(authorization.status).toBe("CREATED");
      expect(authorization.customId).toBe(holdCustomId("s", mid, mandateHash));
    } finally {
      await context.close();
      await release(authorizationId);
    }
  });

  test("closing the popup cancels, keeps the hold pending and offers the same order again", async () => {
    const { sub, mid } = await signed();
    const { context, page } = await appPage(sub, mid);
    try {
      const first = await start(context, page);
      await page.waitForFunction("window.keelson.orders.length === 1");
      await first.close();
      await page.waitForFunction("window.keelson.events.includes('cancel')");
      expect(await row(mid)).toMatchObject({ state: "HOLD_PENDING" });

      const second = await start(context, page);
      await page.waitForFunction("window.keelson.orders.length === 2");
      const { orders, events } = await state(page);
      expect(orders[1]).toBe(orders[0]);
      expect(events).toEqual(["cancel"]);
      expect((await row(mid))?.paypalOrderId).toBe(orders[0]);
      await second.close();
    } finally {
      await context.close();
    }
  });
});
