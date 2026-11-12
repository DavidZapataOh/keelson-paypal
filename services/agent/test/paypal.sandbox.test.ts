import { ToolError } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import { checkoutTotal, decimalOf, type FxReference } from "@keelson/core";
import { type Browser, chromium, type Page } from "playwright";
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

/** Creates a sandbox order for `value` of `currency` and returns its id and approval link. */
async function createOrder(bearer: string, currency: string, value: string, locale: string) {
  const created = await fetch(`${API}/v2/checkout/orders`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: currency,
            value,
            breakdown: { item_total: { currency_code: currency, value } },
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            locale,
            user_action: "PAY_NOW",
            return_url: RETURN,
            cancel_url: `${RETURN}/cancel`,
          },
        },
      },
    }),
  });
  const order = (await created.json()) as { id: string; links: { rel: string; href: string }[] };
  return {
    id: order.id,
    approve: order.links.find((l) => l.rel === "payer-action")?.href as string,
  };
}

/** Signs the sandbox buyer in on PayPal's checkout and waits for its Pay control. */
async function signIn(page: Page, approve: string) {
  await page.goto(approve);
  await page.locator("#email").fill(env.PAYPAL_SANDBOX_BUYER_EMAIL as string);
  await page.getByRole("button", { name: /^(Next|Siguiente)$/ }).click();
  const password = page.locator("input[name=login_password]:visible, #password:visible").first();
  await password.waitFor();
  await password.click();
  await password.pressSequentially(env.PAYPAL_SANDBOX_BUYER_PASSWORD as string);
  await page.getByRole("button", { name: /^(Log In|Iniciar sesión)$/ }).click();
  const pay = page.getByRole("button", {
    name: /^(Pay|Pagar|Pagar ahora|Completar compra|Pay Now|Complete Purchase)$/,
  });
  await pay.waitFor({ timeout: 90_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  return pay;
}

/** Today's reference rates from `base`, from the provider Keelson's countersign uses. */
async function referenceFrom(base: string): Promise<FxReference> {
  const source = `https://open.er-api.com/v6/latest/${base}`;
  const body = (await (await fetch(source)).json()) as {
    time_last_update_unix: number;
    rates: Record<string, number>;
  };
  return {
    v: "keelson.fx_reference/1",
    provider: "ExchangeRate-API",
    source,
    base,
    as_of: new Date(body.time_last_update_unix * 1000).toISOString(),
    fetched_at: new Date().toISOString(),
    rates: Object.fromEntries(Object.entries(body.rates).map(([c, r]) => [c, decimalOf(r)])),
  };
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
      const order = await createOrder(bearer, "USD", "2.95", "es-CO");
      const context = await browser.newContext({ locale: "es-CO" });
      await context.route(`${RETURN}**`, (r) => r.fulfill({ status: 200, body: "" }));
      const gate = new PayGate({ checkoutHosts: ["www.sandbox.paypal.com"] });
      const page = await context.newPage();
      page.setDefaultTimeout(45_000);
      try {
        const pay = await signIn(page, order.approve);

        gate.allow(checkoutTotal("USD", { items: 395 }));
        const held = await gate.check(page, { kind: "click", target: pay }).catch((e) => e);
        expect(held).toBeInstanceOf(ToolError);
        expect(String(held.message)).toMatch(/PayPal's order charges USD 2\.95/);

        gate.allow(checkoutTotal("USD", { items: 295 }));
        await gate.check(page, { kind: "click", target: pay });
        expect(gate.paid?.charge).toMatchObject({ currency: "USD", value: "2.95", intent: "SALE" });
        expect(gate.paid?.funding.buyer).toBe("USD 2.95");
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
    test("a EUR order the buyer funds in USD pays PayPal's convertedAmount, read from PayPal's own data", async () => {
      const bearer = await token();
      const order = await createOrder(bearer, "EUR", "2.95", "es-CO");
      const context = await browser.newContext({ locale: "es-CO" });
      const gate = new PayGate({ checkoutHosts: ["www.sandbox.paypal.com"] });
      const page = await context.newPage();
      page.setDefaultTimeout(45_000);
      try {
        const pay = await signIn(page, order.approve);
        gate.allow(checkoutTotal("EUR", { items: 295 }), await referenceFrom("EUR"));
        await gate.check(page, { kind: "click", target: pay });
        // PayPal serves its `/pay` checkout or its hosted one; either states the funding.
        expect([
          ["xoos.getCheckoutSummary", "xoos.getFundingSelection", "pay-form"],
          ["GetFundingOptions.allPlans"],
        ]).toContainEqual(gate.paid?.funding.sources);
        expect(gate.paid?.conversion).toMatchObject({
          merchant: { currency: "EUR", value: "2.95" },
          buyer: { currency: "USD" },
        });
        expect(gate.paid?.funding.quote).toMatch(/^1 USD = [\d.]+ EUR$/);
      } finally {
        await context.close();
      }
    });
  },
);
