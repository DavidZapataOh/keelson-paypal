import type { Conversion } from "@keelson/core";
import { API } from "./config";
import type { Amount } from "./types";

/**
 * A purchase the agent made with real money at a real store, or a cart Keelson denied there
 * before the payment, as `GET /v1/live-purchases` lists it.
 */
export interface LivePurchase {
  id: string;
  /** The store's origin; `null` for a card purchase, which the card network names. */
  store: string | null;
  merchant: string;
  amount: Amount;
  decision: "allow" | "deny";
  /** The PayPal transaction the store was paid by; `null` for a DENY. */
  transactionId: string | null;
  /** When PayPal converted the charge to the buyer's currency, as the pay-click gate checked it. */
  conversion?: Conversion;
  /** For a DENY, the mandate fields that failed, or leg A's PayPal reason. */
  blocked: string[];
  /** A card purchase: the merchant the card network named and what both enclaves decided. */
  card?: {
    lastFour: string;
    merchantName: string | null;
    mcc: string | null;
    approved: number;
    declined: number;
    settledMinor: string | null;
  };
  logIndex: string;
  createdAt: string;
}

export async function livePurchases(): Promise<LivePurchase[]> {
  const res = await fetch(`${API}/v1/live-purchases`);
  if (!res.ok) throw new Error(`live purchases: ${res.status}`);
  return ((await res.json()) as { purchases: LivePurchase[] }).purchases;
}

/** The public Alibi file of a live purchase. */
export const alibiUrl = (id: string) => `${API}/v1/alibis/${id}`;

const REASONS: Readonly<Record<string, string>> = {
  amount: "Over the per-purchase cap",
  budget: "Over the mandate's budget",
  "paypal.insufficient": "Over the budget held on PayPal",
  "paypal.expired": "The PayPal hold had expired",
  "paypal.currency": "Another currency than the PayPal hold",
  currency: "Another currency than the mandate",
  merchant: "A store the mandate does not allow",
  quantity: "More of an item than the mandate allows",
  category: "A category the mandate does not allow",
  variant: "An item the mandate does not name",
  returns: "Returns shorter than the mandate asks",
  window: "Outside the mandate's dates",
};

/** Why Keelson denied a live cart, in words. */
export const reasonOf = (id: string) =>
  REASONS[id] ??
  (id.startsWith("paypal.") ? "The PayPal hold did not cover it" : id.replaceAll("_", " "));
