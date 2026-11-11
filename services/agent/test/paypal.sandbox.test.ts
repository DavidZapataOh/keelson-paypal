import { ToolError } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import { checkoutTotal } from "@keelson/core";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PayGate } from "../src/gate.ts";

const API = "https://api-m.sandbox.paypal.com";
const RETURN = "https://keelson.finance/return";
const env = process.env;
const ready = Boolean(
  env.PAYPAL_CLIENT_ID &&
    env.PAYPAL_CLIENT_SECRET &&
    env.PAYPAL_SANDBOX_BUYER_EMAIL &&
    env.PAYPAL_SANDBOX_BUYER_PASSWORD,
);

async function token(): Promise<string> {
  const res = await fetch(`${API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

/**
 * PayPal's real hosted checkout on the sandbox, in Colombian Spanish: the gate reads the order from
 * PayPal itself, holds the pay click for another total, and lets it through for the countersigned
 * one; the order is then captured.
 */
describe.skipIf(!ready)(
  "the pay-click gate on PayPal's sandbox checkout",
  { timeout: 240_000 },
  () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await chromium.launch({ headless: env.PLAYWRIGHT_HEADED !== "1" });
    });
    afterAll(async () => {
      await browser?.close();
    });

    test("in es-CO, pays exactly the order PayPal states, and the order captures", async () => {
      const bearer = await token();
      const created = await fetch(`${API}/v2/checkout/orders`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [
            {
              amount: {
                currency_code: "USD",
                value: "2.95",
                breakdown: { item_total: { currency_code: "USD", value: "2.95" } },
              },
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                locale: "es-CO",
                user_action: "PAY_NOW",
                return_url: RETURN,
                cancel_url: `${RETURN}/cancel`,
              },
            },
          },
        }),
      });
      const order = (await created.json()) as {
        id: string;
        links: { rel: string; href: string }[];
      };
      const approve = order.links.find((l) => l.rel === "payer-action")?.href as string;

      const context = await browser.newContext({ locale: "es-CO" });
      await context.route(`${RETURN}**`, (r) => r.fulfill({ status: 200, body: "" }));
      const gate = new PayGate({ checkoutHosts: ["www.sandbox.paypal.com"] });
      const page = await context.newPage();
      page.setDefaultTimeout(45_000);
      try {
        await page.goto(approve);
        await page.locator("#email").fill(env.PAYPAL_SANDBOX_BUYER_EMAIL as string);
        await page.locator("#btnNext").click();
        await page.locator("#password").fill(env.PAYPAL_SANDBOX_BUYER_PASSWORD as string);
        await page.locator("#btnLogin").click();
        const pay = page.getByRole("button", {
          name: /^(Pagar ahora|Completar compra|Pay Now|Complete Purchase)$/,
        });
        await pay.waitFor();
        await page.waitForLoadState("networkidle").catch(() => {});

        gate.allow(checkoutTotal("USD", { items: 395 }));
        const held = await gate.check(page, { kind: "click", target: pay }).catch((e) => e);
        expect(held).toBeInstanceOf(ToolError);
        expect(String(held.message)).toMatch(/PayPal's order charges USD 2\.95/);

        gate.allow(checkoutTotal("USD", { items: 295 }));
        await gate.check(page, { kind: "click", target: pay });
        expect(gate.paid?.charge).toMatchObject({ currency: "USD", value: "2.95", intent: "SALE" });
        await pay.click();
        await page.waitForURL((u) => u.href.startsWith(RETURN), { timeout: 60_000 });
      } finally {
        await context.close();
      }

      const captured = await fetch(`${API}/v2/checkout/orders/${order.id}/capture`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      });
      const result = (await captured.json()) as {
        status: string;
        purchase_units: { payments: { captures: { amount: { value: string } }[] } }[];
      };
      expect(result.status).toBe("COMPLETED");
      expect(result.purchase_units[0]?.payments.captures[0]?.amount.value).toBe("2.95");
    });
  },
);
