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

export interface Purchase {
  id: string;
  merchantId: string;
  amount: { currency: string; minor: string };
  createdAt: string;
  state: string;
  mode: "2of2" | "degraded" | null;
  logIndex?: string;
  coverage?: { chainId: number; txHash: string | null };
  capture?: { id: string; invoiceId: string; status: string | null };
  failure?: { step: string; reason: string };
  disputes: { id: string; state: "OPEN" | "ATTRIBUTED" | "RESOLVED" }[];
}

export interface MandateView {
  id: string;
  state: MandateState;
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
