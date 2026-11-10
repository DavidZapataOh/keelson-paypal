import type { Mandate } from "@keelson/mandate";
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
    "_.shopify.com",
    "_.shopifycdn.com",
    "_.shopifyinc.com",
    "_.shopifysvc.com",
    "shop.app",
    "www.paypal.com",
    "_.paypal.com",
    "www.paypalobjects.com",
    "_.hcaptcha.com",
  ],
  checkoutHosts: ["www.paypal.com", "_.paypal.com", "shop.app", "_.shop.app"],
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
 * most `maxMinor`, final sale. `paypalMerchantId` names the store's PayPal account.
 */
export function liveMandate(m: Mandate, maxMinor: number, paypalMerchantId: string): Mandate {
  m.intent = {
    ...m.intent,
    prompt_summary: `Digital sheet music of "The Change" for piano, vocal and chords, from Alfred Music, at most ${usd(maxMinor)}`,
  };
  m.payment.constraints = m.payment.constraints.map((c) =>
    c.type === "payment.budget" || c.type === "payment.amount_range" ? { ...c, max: maxMinor } : c,
  );
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
