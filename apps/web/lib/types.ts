import type { Card, FieldId, Mandate } from "@keelson/mandate/browser";

export type MandateState =
  | "DRAFT"
  | "COMPILED"
  | "SIGNED"
  | "HOLD_PENDING"
  | "ACTIVE"
  | "EXHAUSTED"
  | "EXPIRED"
  | "REVOKED";

interface Budget {
  currency: string;
  maxMinor: string;
  remainingMinor: string;
}

export interface MandateSummary {
  id: string;
  state: MandateState;
  budget: Budget;
  merchantIds: string[];
  holdMode: "mandate" | "per_purchase";
  expiresAt: string;
  createdAt: string;
}

/**
 * A countersigned total in minor units and, when the purchase's evidence holds it, what it is
 * made of: the items, plus tax and shipping, less discounts.
 */
export interface Amount {
  currency: string;
  minor: string;
  breakdown?: { items: string; tax: string; shipping: string; discount: string };
}

export interface Purchase {
  id: string;
  merchantId: string;
  amount: Amount;
  createdAt: string;
  state: string;
  mode: "2of2" | "degraded" | null;
  logIndex?: string;
  coverage?: { chainId: number; txHash: string | null };
  capture?: { id: string; invoiceId: string; status: string | null };
  failure?: { step: string; reason: string };
  /** For a blocked cart, the mandate fields whose check failed. */
  blocked?: string[];
  /** For a blocked cart, each failed field with what the mandate allowed and what the cart had. */
  reasons?: { field: string; mandate: string | null; cart: string | null }[];
  /** For a checked purchase, each mandate field with both values and whether it held. */
  checks?: { field: string; mandate: string | null; cart: string | null; pass: boolean }[];
  disputes: { id: string; state: "OPEN" | "ATTRIBUTED" | "RESOLVED" }[];
  /** A card purchase: its single-use card, never its number, and each network authorization. */
  card?: PurchaseCard;
}

/** One card network authorization of a purchase's single-use card, as both enclaves decided it. */
export interface CardAuthorization {
  id: string;
  amountMinor: string;
  currency: string;
  mcc: string;
  merchantName: string;
  merchantCountry: string;
  approved: boolean;
  /** The enclaves' reasons to decline, as `CARD_BITS` names them. */
  failedMask: number;
  /** Why it was declined without both enclaves' answers. */
  reason: string | null;
  legs: { tdx: boolean; nitro: boolean };
  latencyMs: number;
  at: string;
}

export interface PurchaseCard {
  issuer: string;
  lastFour: string;
  state: "PAUSED" | "OPEN" | "USED" | "CLOSED";
  expiresAt: string;
  controls: { spend_limit_minor?: string; currency?: string; mcc?: string[]; countries?: string[] };
  settledMinor: string | null;
  chargebacks: Chargeback[];
  /** The most a bond claim may still pay: the settled amount less what chargebacks returned. */
  bondClaimMinor: string;
  authorizations: CardAuthorization[];
}

/** A chargeback filed through the card issuer over a card purchase. */
export interface Chargeback {
  id: string;
  reason: "not_received" | "not_as_described" | "unauthorized";
  networkCodes: { visa: string; mastercard: string };
  amountMinor: string;
  status: string;
  resolution: string | null;
  recoveredMinor: string | null;
  evidenceUploaded: boolean;
}

export interface MandateView {
  id: string;
  state: MandateState;
  rail?: "paypal" | "card";
  mandateHash: string | null;
  budget: Budget;
  expiresAt: string;
  hold: {
    mode: "mandate" | "per_purchase";
    orderId: string;
    authorizationId: string | null;
    state: "PENDING" | "AUTHORIZED" | "RELEASED";
    remainingMinor: string;
  } | null;
  card: Card | null;
  purchases: Purchase[];
  /** Purchases of a several-store mandate waiting for the buyer's PayPal approval. */
  pendingHolds: PendingHold[];
  /** The mandate's entry in the public status list, when it has one. */
  status?: { uri: string; idx: number; revoked: boolean } | null;
}

/** A purchase of a several-store mandate waiting for the buyer's PayPal approval. */
interface PendingHold {
  requestId: string;
  orderId: string;
  merchant: string;
  amountMinor: string;
}

export interface Compiled {
  mandateDraft: Mandate;
  card: Card;
  ambiguous: FieldId[];
  check: { status: string; discrepancies: { field: string; issue: string }[] | null };
}

export interface Dispute {
  dispute_id: string;
  purchase_id: string;
  state: "OPEN" | "ATTRIBUTED" | "RESOLVED";
  reason: string;
  liable: "operator" | "keelson" | "merchant" | "user" | null;
  elapsed_ms: number | null;
  verdict: { rule: string } | null;
  settlement: {
    outcome: string | null;
    refund_id: string | null;
    explorer_url: string | null;
  } | null;
}
