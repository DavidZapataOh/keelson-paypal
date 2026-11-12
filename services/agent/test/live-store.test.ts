import { allowedPayees, type Mandate } from "@keelson/mandate";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ALFRED, liveMandate, storePayPalMerchantId } from "../src/live-store.ts";

const mandate = () =>
  ({
    intent: { prompt_summary: "" },
    payment: {
      constraints: [
        { type: "payment.budget", max: 500, currency: "USD" },
        { type: "payment.allowed_payees", allowed: [{ paypal_merchant_id: "SANDBOXPAYEE01" }] },
      ],
    },
    checkout: {
      constraints: [
        {
          type: "checkout.allowed_merchants",
          allowed: [{ id: "mrc_x", name: "X", website: "https://x.example" }],
        },
      ],
    },
  }) as unknown as Mandate;

describe("the live mandate", () => {
  test("names the store's PayPal merchant id as its only payee and its merchant's", () => {
    const m = liveMandate(mandate(), 800, ALFRED.paypalMerchantId);
    expect(ALFRED.paypalMerchantId).toBe("DZ93UDZC2BKLE");
    expect(allowedPayees(m)).toEqual(["DZ93UDZC2BKLE"]);
    const merchants = m.checkout.constraints.find((c) => c.type === "checkout.allowed_merchants");
    expect(merchants).toMatchObject({ allowed: [{ paypal_merchant_id: "DZ93UDZC2BKLE" }] });
  });

  test("is never signed with a placeholder for the store's PayPal merchant id", () => {
    expect(() => liveMandate(mandate(), 800, "unknown")).toThrow(/PayPal merchant id/);
    expect(() => liveMandate(mandate(), 800, "")).toThrow(/PayPal merchant id/);
  });
});

describe("the PayPal merchant id a store's own PayPal integration names", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  const read = async (scripts: string) => {
    const page = await browser.newPage();
    try {
      // Only the tags are read; the SDK itself is never loaded.
      await page.route("https://www.paypal.com/**", (r) => r.abort());
      await page.setContent(`<html><head>${scripts}</head><body></body></html>`);
      return await storePayPalMerchantId(page);
    } finally {
      await page.close();
    }
  };
  const sdk = (query: string, attrs = "") =>
    `<script src="https://www.paypal.com/sdk/js?${query}" ${attrs}></script>`;

  test("is the SDK's merchant-id, or its data-merchant-id for one merchant", async () => {
    expect(await read(sdk("client-id=abc&merchant-id=DZ93UDZC2BKLE&currency=USD"))).toBe(
      "DZ93UDZC2BKLE",
    );
    expect(await read(sdk("client-id=abc&merchant-id=*", 'data-merchant-id="DZ93UDZC2BKLE"'))).toBe(
      "DZ93UDZC2BKLE",
    );
  });

  test("is none when the store's PayPal names no single valid merchant", async () => {
    expect(await read(sdk("client-id=abc"))).toBeUndefined();
    expect(await read(sdk("client-id=abc&merchant-id=unknown"))).toBeUndefined();
    expect(
      await read(
        sdk("client-id=abc&merchant-id=*", 'data-merchant-id="DZ93UDZC2BKLE,MERCH7XK2Q9LD"'),
      ),
    ).toBeUndefined();
    expect(
      await read(
        sdk("client-id=a&merchant-id=DZ93UDZC2BKLE") + sdk("client-id=b&merchant-id=MERCH7XK2Q9LD"),
      ),
    ).toBeUndefined();
    expect(
      await read('<script src="https://evil.example/sdk/js?merchant-id=DZ93UDZC2BKLE"></script>'),
    ).toBeUndefined();
  });
});
