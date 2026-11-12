import { isPayPalMerchantId, type Mandate } from "@keelson/mandate";
import type { Page } from "playwright";
import type { LiveStore } from "./live.ts";

/**
 * The real store of the live flow: Alfred Music, the music publisher, on Shopify. It sells
 * digital sheet music for a few dollars, delivered as a download with no shipping, and its
 * checkout takes PayPal. Its public product JSON (`.oembed`, under 1 KB) fits the TLSNotary prover.
 */
export const ALFRED: LiveStore = {
  origin: "https://www.alfred.com",
  merchant: "mrc_alfred",
  // Media: the mandate's category table holds the top-level categories (Sheet Music is gpt:887).
  category: "gpt:783",
  // Digital sheet music is final sale.
  returnDays: 0,
  returnsFree: false,
  hosts: [
    "www.alfred.com",
    "*.shopify.com",
    "*.shopifycdn.com",
    "*.shopifyinc.com",
    "*.shopifysvc.com",
    "shop.app",
    "www.paypal.com",
    "*.paypal.com",
    "www.paypalobjects.com",
    "*.hcaptcha.com",
  ],
  checkoutHosts: ["www.paypal.com", "*.paypal.com", "shop.app", "*.shop.app"],
  // The payee PayPal's own orders at its checkout name.
  paypalMerchantId: "DZ93UDZC2BKLE",
};

/** The live flow's item: one digital copy of "The Change" for piano, vocal and chords. */
export const LIVE_ITEM = {
  path: "/products/the-change-00-ps-0004070",
  sku: "00-PS-0004070",
  title: "The Change: Piano/Vocal/Chords Digital Sheet Music",
} as const;

const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;

/**
 * Narrows a mandate to the live purchase: one digital copy of the live item from Alfred Music, at
 * most `maxMinor`, final sale, paid only to the store's PayPal account `paypalMerchantId`, which
 * must be a PayPal merchant id: a mandate is never signed for a payee it cannot name.
 */
export function liveMandate(m: Mandate, maxMinor: number, paypalMerchantId: string): Mandate {
  if (!isPayPalMerchantId(paypalMerchantId)) {
    throw new Error("the store's PayPal merchant id is not known; no mandate is signed without it");
  }
  m.intent = {
    ...m.intent,
    prompt_summary: `Digital sheet music of "The Change" for piano, vocal and chords, from Alfred Music, at most ${usd(maxMinor)}`,
  };
  m.payment.constraints = m.payment.constraints.map((c) => {
    if (c.type === "payment.budget" || c.type === "payment.amount_range") {
      return { ...c, max: maxMinor };
    }
    if (c.type === "payment.allowed_payees") {
      return { ...c, allowed: [{ paypal_merchant_id: paypalMerchantId }] };
    }
    return c;
  });
  m.checkout.constraints = m.checkout.constraints.map((c) => {
    switch (c.type) {
      case "checkout.line_items":
        return {
          ...c,
          items: [
            {
              id: "l1",
              acceptable_items: [{ id: LIVE_ITEM.sku, title: LIVE_ITEM.title }],
              quantity: 1,
            },
          ],
        };
      case "checkout.allowed_merchants":
        return {
          ...c,
          allowed: [
            {
              id: ALFRED.merchant,
              name: "Alfred Music",
              website: ALFRED.origin,
              paypal_merchant_id: paypalMerchantId,
            },
          ],
        };
      case "keelson.category":
        return { ...c, allow: [ALFRED.category], deny: [] };
      case "keelson.attributes":
        return { ...c, must: {} };
      case "keelson.returns":
        return { ...c, min_days: 0, free: false };
      default:
        return c;
    }
  });
  return m;
}

/**
 * The PayPal merchant id the store's own PayPal integration names on `page`: the PayPal JS SDK's
 * `merchant-id`, or its `data-merchant-id` when that is `*`. Undefined unless the page names
 * exactly one valid id. Cart platforms may load the SDK with the store's client id alone, which
 * names none.
 */
export async function storePayPalMerchantId(page: Page): Promise<string | undefined> {
  const named = await page
    .locator('script[src^="https://www.paypal.com/sdk/js?"]')
    .evaluateAll((tags) =>
      tags.flatMap((t) => {
        const id = new URL((t as HTMLScriptElement).src).searchParams.get("merchant-id") ?? "";
        return id === "*" ? (t.getAttribute("data-merchant-id") ?? "").split(",") : [id];
      }),
    );
  const ids = [...new Set(named.map((id) => id.trim()))];
  return ids.length === 1 && isPayPalMerchantId(ids[0] as string) ? ids[0] : undefined;
}
