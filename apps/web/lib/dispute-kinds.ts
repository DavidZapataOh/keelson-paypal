import type { Dispute } from "./types";

/** Mastercard's four kinds of agentic dispute, as a buyer says them. */
export const DISPUTE_KINDS = {
  unrecognized: {
    label: "I don't remember it",
    detail: "Your passkey signed a mandate that allowed this. Check the receipt first.",
  },
  intent: {
    label: "Not what I meant",
    detail: "It matched what you signed, but not what you wanted.",
  },
  rogue: {
    label: "The agent went rogue",
    detail: "It bought outside what you signed.",
  },
  error: {
    label: "The agent got it wrong",
    detail: "A detail it vouched for, like the size, was wrong.",
  },
} as const;

export type DisputeKind = keyof typeof DISPUTE_KINDS;

/** Which kind a dispute turned out to be, from PayPal's reason and who Keelson found liable. */
export function kindOf(d: Pick<Dispute, "reason" | "liable">): DisputeKind {
  if (d.liable === "operator") return "error";
  if (d.liable === "keelson") return "rogue";
  if (d.liable === "user") return "intent";
  return d.reason === "UNAUTHORISED" ? "unrecognized" : "intent";
}
