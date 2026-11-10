import { approveOnPage } from "@keelson/paypal/testing";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { STORE_REFERENCE } from "../src/orders.ts";
import { app, deps, ORIGIN } from "./setup.ts";

const live = process.env.KEELSON_LIVE === "1";
/** The deployed store; without it Playwright answers the store's origin from this process. */
const deployed = process.env.STORE_URL;
const origin = deployed ?? ORIGIN;

describe.skipIf(!live)(
  "a human buys with the sandbox buyer (v6 checkout)",
  { timeout: 300_000 },
  () => {
    let browser!: Browser;

    beforeAll(async () => {
      browser = await chromium.launch({ headless: process.env.PLAYWRIGHT_HEADED !== "1" });
    });
    afterAll(async () => {
      await browser?.close();
    });

    test("product page → PayPal popup → Pay Now → confirmation with a completed capture", async () => {
      const context = await browser.newContext({ locale: "en-US" });
      if (!deployed) {
        await context.route(`${ORIGIN}/**`, async (route) => {
          const r = route.request();
          const body = r.postDataBuffer();
          const res = await app.request(r.url(), {
            method: r.method(),
            headers: await r.allHeaders(),
            ...(body ? { body: new Uint8Array(body) } : {}),
          });
          await route.fulfill({
            status: res.status,
            headers: Object.fromEntries(res.headers),
            body: Buffer.from(await res.arrayBuffer()),
          });
        });
      }
      const page = await context.newPage();
      page.setDefaultTimeout(45_000);
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      try {
        const loading = performance.now();
        await page.goto(`${origin}/products/tempo-3`);
        await page.locator("paypal-button:not([hidden])").waitFor();
        console.info(`page to PayPal button: ${Math.round(performance.now() - loading)} ms`);
        await page.getByLabel("Size").selectOption("10");

        const opened = context.waitForEvent("page", { timeout: 15_000 });
        await page.locator("paypal-button").click();
        const popup = await opened;
        popup.setDefaultTimeout(45_000);
        await popup.waitForLoadState();
        await approveOnPage(popup);
        const paid = performance.now();

        await page.waitForURL(/\/orders\/[A-Z0-9]+$/, { timeout: 60_000 }).catch(async (cause) => {
          const shown = await page.locator("[role=status]").textContent();
          throw new Error(
            `no confirmation; the page says "${shown}"; console: ${errors.join(" | ")}`,
            {
              cause,
            },
          );
        });
        await page.getByRole("heading", { name: "Order confirmed" }).waitFor();
        console.info(`Pay Now to confirmation: ${Math.round(performance.now() - paid)} ms`);

        const id = new URL(page.url()).pathname.split("/").at(-1) as string;
        const { result: order } = await deps.paypal.orders.getOrder({ id });
        expect(order.status).toBe("COMPLETED");
        const unit = order.purchaseUnits?.[0];
        expect(unit?.referenceId).toBe(STORE_REFERENCE);
        const capture = unit?.payments?.captures?.[0];
        expect(capture?.status).toBe("COMPLETED");
        expect(capture?.amount).toMatchObject({ currencyCode: "USD", value: "129.00" });
        expect(await page.getByText(capture?.id as string).count()).toBeGreaterThan(0);
        console.info(`order ${id}, capture ${capture?.id}`);
        expect(errors.filter((e) => /Content Security Policy/i.test(e))).toEqual([]);
      } finally {
        await context.close();
      }
    });
  },
);
