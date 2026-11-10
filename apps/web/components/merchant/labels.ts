import type { MerchantDispute } from "../../lib/merchant";

export const LIABLE: Record<NonNullable<MerchantDispute["liable"]>, string> = {
  operator: "Agent operator",
  keelson: "Keelson",
  merchant: "Merchant",
  user: "Buyer",
};

export const PAID_BY: Record<NonNullable<MerchantDispute["paid_by"]>, string> = {
  chain: "The operator's bond or Keelson's reserve, on chain,",
  treasury: "Keelson's treasury",
  "violation-pool": "The operator's violation pool",
};

export const PAID_BY_SHORT: Record<NonNullable<MerchantDispute["paid_by"]>, string> = {
  chain: "Bond or reserve",
  treasury: "Keelson treasury",
  "violation-pool": "Violation pool",
};

export const RAIL: Record<NonNullable<MerchantDispute["rail"]>, string> = {
  pyusd: "PYUSD on chain",
  paypal: "PayPal Payout",
};

/** State as word, glyph and tone together. */
export const OUTCOME = {
  paid: { text: "Paid", glyph: "✓", tone: "text-ok" },
  queued: { text: "Queued", glyph: "◷", tone: "text-warn" },
  claimable: { text: "Claimable", glyph: "◇", tone: "text-warn" },
  failed: { text: "Failed", glyph: "✕", tone: "text-destructive" },
  open: { text: "Open", glyph: "○", tone: "text-foreground" },
} as const;

/** Mandate policy ids as a merchant reads them. */
export const FIELD: Record<string, string> = {
  amount: "Price (cart total)",
  budget: "Budget",
  variant: "Variant (size, SKU)",
  category: "Category",
  merchant: "Merchant",
  quantity: "Quantity",
  returns: "Return window",
  returns_free: "Free returns",
  currency: "Currency",
  window: "Time window",
  agent: "Agent identity",
  sanity: "Cart sanity",
};
