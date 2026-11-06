import type { Merchant } from "@keelson/compiler";

/**
 * The merchants onboarded to Keelson: the directory compiled mandates resolve store names
 * against. RunFast is the demo store, a PayPal sandbox business account.
 */
export const MERCHANTS: readonly Merchant[] = [
  {
    id: "mrc_runfast",
    name: "RunFast",
    website: "https://store.keelson.finance",
    paypal_merchant_id: "A4WCRYD5EYDF2",
  },
];
