import type { StatusState } from "@keelson/ui/components/status";
import type { MandateState, Purchase } from "./types";

/** PayPal's own answers to a capture: with one of these, nothing was charged. */
const DECLINED = new Set(["DENIED", "DECLINED", "FAILED"]);

/**
 * A purchase that failed at the capture step without PayPal declining it: the capture may have
 * reached PayPal, so whether the buyer was charged is not known until PayPal is read again.
 */
export const unknownOutcome = (p: Purchase): boolean =>
  p.failure?.step === "capture" && !DECLINED.has(p.failure.reason);

/** A purchase's chip: what Keelson or PayPal last did with it. */
export function purchaseStatus(p: Purchase): StatusState {
  if (p.disputes.some((d) => d.state !== "RESOLVED")) return "disputed";
  if (unknownOutcome(p)) return "unknown";
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
