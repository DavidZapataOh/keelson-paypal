import type { Merchant } from "@keelson/compiler";
import { type Db, eq, merchantSettlement } from "@keelson/db";
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

/**
 * Keelson's treasury: it receives the PYUSD of merchants paid through PayPal, and pays them a Payout.
 *
 * @internal
 */
export const KEELSON_TREASURY: Address = "0xbEE85Cd040cf4C7D0851fFc5655d7e3a75f84B16";

export type Rail = "pyusd" | "paypal";

export interface Settlement {
  rail: Rail;
  /** The PayPal account a `paypal` rail pays. */
  paypalReceiver: string | null;
}

/** How a merchant is paid; PYUSD on chain unless it chose PayPal. */
export async function settlementOf(db: Db, merchantId: string): Promise<Settlement> {
  const [row] = await db
    .select({ rail: merchantSettlement.rail, paypalReceiver: merchantSettlement.paypalReceiver })
    .from(merchantSettlement)
    .where(eq(merchantSettlement.merchantId, merchantId));
  return row ? { rail: row.rail as Rail, paypalReceiver: row.paypalReceiver } : DEFAULT_SETTLEMENT;
}

const DEFAULT_SETTLEMENT: Settlement = { rail: "pyusd", paypalReceiver: null };

/** The payee a verdict names: the merchant's settlement address, or the treasury for `paypal`. */
export function payeeFor(merchantId: string, rail: Rail): Address {
  if (rail === "paypal") return KEELSON_TREASURY;
  const payee = SETTLEMENT[merchantId];
  if (!payee) throw new Error(`merchant ${merchantId} has no settlement address`);
  return payee;
}
