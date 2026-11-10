import { API } from "./config";

/** A purchase the agent made with real money at a real store, as `GET /v1/live-purchases` lists it. */
export interface LivePurchase {
  id: string;
  store: string;
  merchant: string;
  amount: { currency: string; minor: string };
  transactionId: string;
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
