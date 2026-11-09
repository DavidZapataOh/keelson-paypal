import type { Merchant } from "@keelson/compiler";
import type { Address } from "viem";

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

/** The address each merchant's covered purchases name on chain, for the vault's `CoverageLocked`. */
export const SETTLEMENT: Readonly<Record<string, Address>> = {
  mrc_runfast: "0x467D2beBb479D9B80Ab1c461243E05A2b82387d8",
};
