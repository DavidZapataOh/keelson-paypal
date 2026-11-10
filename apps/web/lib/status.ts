import type { StatusState } from "@keelson/ui/components/status";
import type { MandateState, Purchase } from "./types";

/** A purchase's chip: what Keelson or PayPal last did with it. */
export function purchaseStatus(p: Purchase): StatusState {
  if (p.disputes.some((d) => d.state !== "RESOLVED")) return "disputed";
  switch (p.state) {
    case "PROPOSED":
    case "EVALUATING":
      return "checking";
    case "DENIED":
      return "blocked";
    case "COUNTERSIGNED":
    case "LOGGED":
    case "COVERED":
      return "countersigned";
    case "CAPTURED":
    case "DELIVERED":
    case "SETTLED":
      return "captured";
    case "DISPUTED":
    case "ATTRIBUTED":
      return "disputed";
    case "SLASHED":
      return "bond-slashed";
    case "WARRANTY_PAID":
    case "DEFENDED":
    case "MERCHANT_LIABLE":
      return "resolved";
    default:
      return "error";
  }
}

const MANDATE: Record<MandateState, string> = {
  DRAFT: "Draft",
  COMPILED: "Draft",
  SIGNED: "Signed · approve the hold",
  HOLD_PENDING: "Waiting for PayPal",
  ACTIVE: "Active",
  EXHAUSTED: "Budget spent",
  EXPIRED: "Expired",
  REVOKED: "Revoked",
};

export const mandateLabel = (state: MandateState): string => MANDATE[state];
