import type Anthropic from "@anthropic-ai/sdk";
import { checkoutTotal } from "@keelson/core";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PayGate } from "../src/gate.ts";
import { describeStop, outcomeOf, runCheckout, scrub } from "../src/live.ts";

const DECLINED_PAGE = `<!doctype html><html lang="en"><body>
<main>
  <h1>Payment</h1>
  <div role="alert">Your payment couldn't be processed for Ana Prueba (ana@example.test), card ending 3076. Try another payment method.</div>
  <form>
    <label for="email">Email</label><input id="email" name="email" required value="ana@example.test">
    <label for="phone">Phone</label><input id="phone" name="phone" required value="+57 300 555 0101">
    <label for="note">Order note</label><input id="note" name="note" value="gift">
    <input type="hidden" name="token" value="secret">
    <button type="submit">Pay now</button>
    <button type="button" style="display:none">Hidden button</button>
  </form>
</main></body></html>`;

describe("the end of an agent's checkout", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  test("a note keeps its words and loses emails and long numbers", () => {
    expect(
      scrub(
        "PayPal declined the card ending 3076 for ana@example.test; call +57 300 555 0101.\n\nRetry?",
      ),
    ).toBe("PayPal declined the card ending # for <email>; call +#. Retry?");
    expect(scrub("x".repeat(400))).toHaveLength(300);
  });

  test("a stop is a decline when a payment went through the gate and the store shows an alert, not a confirmation", () => {
    const declined = { confirmation: false, alerts: ["Your payment couldn't be processed."] };
    expect(outcomeOf("declined", declined, false)).toBe("declined");
    expect(outcomeOf("stopped", declined, true)).toBe("declined");
    // Before any payment the gate let through, an alert is a form error, not a decline.
    expect(outcomeOf("stopped", declined, false)).toBe("stopped");
    expect(outcomeOf("stopped", { confirmation: false, alerts: [] }, true)).toBe("stopped");
    expect(outcomeOf("stopped", { confirmation: true, alerts: ["x"] }, true)).toBe("stopped");
    expect(outcomeOf("paid", { confirmation: true, alerts: [] }, true)).toBe("paid");
    expect(outcomeOf("blocked", declined, false)).toBe("blocked");
  });

  test("the page where it stopped is described with labels and buttons only, no values", async () => {
    const page = await browser.newPage();
    await page.setContent(DECLINED_PAGE);
    const described = await describeStop(page);
    await page.close();
    expect(described).toEqual({
      confirmation: false,
      alerts: [
        "Your payment couldn't be processed for Ana Prueba (<email>), card ending #. Try another payment method.",
      ],
      required: ["Email", "Phone"],
      buttons: ["Pay now"],
    });
    expect(JSON.stringify(described)).not.toMatch(/555|secret|gift|3076/);
  });

  test("a checkout the store declines after the gate let the payment through ends declined, with its note and page", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(DECLINED_PAGE);
    const gate = new PayGate({ checkoutHosts: [] });
    // The gate let a pay action through: what it paid with.
    gate.paid = {
      charge: {
        intent: "AUTHORIZE",
        currency: "USD",
        value: "2.95",
        subtotal: "0.00",
        shipping: "0.00",
        tax: "0.00",
        discount: "0.00",
        payee: "SANDBOXPAYEE01",
      },
      funding: { sources: ["pay-form"] },
    };
    const finish = (status: string, note: string) =>
      ({
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "tool_use", id: "toolu_1", name: "finish", input: { status, note } }],
      }) as unknown as Anthropic.Beta.BetaMessage;
    const client = {
      beta: {
        messages: {
          create: async () =>
            finish("stopped", "The store says the payment for ana@example.test failed."),
        },
      },
    } as unknown as Anthropic;
    const total = checkoutTotal("USD", { items: 295 });
    const run = await runCheckout({
      client,
      context,
      page,
      hosts: ["127.0.0.1"],
      gate,
      quote: {
        cart: {
          merchant: "mrc_test",
          currency: "USD",
          lines: [
            {
              sku: "S",
              size: null,
              color: null,
              category: "gpt:887",
              qty: 1,
              unit_minor: 295,
            },
          ],
          return_days: 0,
          returns_free: false,
        },
        total,
        products: [],
      } as unknown as Parameters<typeof runCheckout>[0]["quote"],
      proposal: { lines: [{ product_url: "http://127.0.0.1/p", size: "", qty: 1 }], reason: "" },
    });
    await context.close();
    expect(run.outcome).toBe("declined");
    expect(run.note).toBe("The store says the payment for <email> failed.");
    expect(run.stop).toMatchObject({ confirmation: false, required: ["Email", "Phone"] });
  });
});
