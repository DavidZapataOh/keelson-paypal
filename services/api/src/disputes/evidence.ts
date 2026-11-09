import type { Evidence } from "@keelson/paypal";

/** The party a verdict names, by its `liable` value. */
const PARTIES = ["operator", "keelson", "merchant", "user"] as const;
type Party = (typeof PARTIES)[number];

/** The file the Alibi PDF is uploaded as. */
export const ALIBI_FILE = "alibi.pdf";

/** What each attribution rule found, in the words the response to PayPal uses. */
const FINDINGS: Readonly<Record<number, string>> = {
  0: "The purchase lacks a valid proof (mandate, countersignature, log inclusion or attestation); the agent's operator is responsible.",
  10: "The carrier's tracking confirms the item was delivered.",
  11: "The item was not received; the merchant is responsible for delivery.",
  20: "A refund for this purchase is already recorded.",
  21: "The credit was not processed; the merchant is responsible for it.",
  30: "Keelson countersigned a single-use mandate twice; Keelson is responsible.",
  31: "The merchant captured more than once under a single countersignature; the agent's operator is responsible.",
  32: "There is no duplicate: one countersigned purchase was captured once.",
  35: "The merchant is responsible for this dispute reason.",
  40: "The captured amount differs from the countersigned total; the merchant set the capture.",
  50: "What was delivered differs from the attested item snapshot; the merchant is responsible.",
  60: "A mandate field Keelson guarantees failed; Keelson is responsible.",
  61: "A mandate field the agent's operator attested failed; the operator is responsible.",
  62: "Only a field the buyer chose not to restrict differs; the purchase stayed within the mandate the buyer signed.",
  70: "The purchase met every field of the mandate the buyer signed.",
};

export interface Verdict {
  ruleId: number;
  /** 1 operator, 2 Keelson, 3 merchant, 4 user. */
  liable: number;
}

/** The PayPal reads a response can cite beyond the dispute. */
export interface OrderRead {
  purchaseUnits?:
    | {
        payments?: { refunds?: { id?: string | undefined }[] | undefined } | undefined;
        shipping?: { trackers?: { id?: string | undefined }[] | undefined } | undefined;
      }[]
    | undefined;
}

export type ResponsePlan =
  | { action: "accept"; party: Party; ruleId: number; finding: string }
  | {
      action: "contest";
      party: Party;
      ruleId: number;
      finding: string;
      /** The evidences to submit, without notes; the Alibi PDF goes with `ORDER_DETAILS`. */
      evidences: Evidence[];
    };

const withAlibi = (evidence_type: string): Evidence => ({
  evidence_type,
  documents: [{ name: ALIBI_FILE }],
});

/**
 * The answer to PayPal a verdict calls for. The rule alone fixes the action and the evidence
 * type: when the user or the merchant is at fault the dispute is contested with the Alibi;
 * otherwise the claim is accepted and the buyer refunded. One evidence per submission: PayPal
 * requires an `item_id` on each of several evidences, and a Keelson order has no item ids.
 */
export function responsePlan(verdict: Verdict, order: OrderRead = {}): ResponsePlan {
  const finding = FINDINGS[verdict.ruleId];
  const party = PARTIES[verdict.liable - 1];
  if (finding === undefined || party === undefined) {
    throw new Error(`no response for rule ${verdict.ruleId} with liable ${verdict.liable}`);
  }
  const { ruleId } = verdict;
  if (party === "operator" || party === "keelson")
    return { action: "accept", party, ruleId, finding };

  const units = order.purchaseUnits ?? [];
  let evidence: Evidence;
  if (ruleId === 10) {
    evidence = withAlibi("ONLINE_TRACKING_INFORMATION");
  } else if (ruleId === 20) {
    const refundIds = units.flatMap((u) => u.payments?.refunds ?? []).flatMap((r) => r.id ?? []);
    if (refundIds.length === 0) throw new Error("rule 20 without a refund on the order");
    // PayPal expects `evidence_info` rather than documents for a proof of refund.
    evidence = { evidence_type: "PROOF_OF_REFUND", evidence_info: { refund_ids: refundIds } };
  } else if (party === "user") {
    evidence = withAlibi("PERMISSION_DESCRIPTION");
  } else {
    evidence = withAlibi("ORDER_DETAILS");
  }
  const evidences = [evidence];
  return { action: "contest", party, ruleId, finding, evidences };
}

/** The tracker ids of the order, cited by the tracking evidence. */
export const trackerIds = (order: OrderRead): string[] =>
  (order.purchaseUnits ?? []).flatMap((u) => u.shipping?.trackers ?? []).flatMap((t) => t.id ?? []);

export type Step = "provide_evidence" | "send_message" | "accept_claim";

/**
 * The call that carries the plan out now, from the dispute's HATEOAS links: evidence once PayPal
 * asks for it, a message while the dispute is still an inquiry, or nothing until the dispute moves.
 */
export function nextStep(plan: ResponsePlan, links: readonly { rel: string }[]): Step | null {
  const rels = new Set(links.map((l) => l.rel));
  if (plan.action === "accept") return rels.has("accept_claim") ? "accept_claim" : null;
  if (rels.has("provide_evidence")) return "provide_evidence";
  if (rels.has("send_message")) return "send_message";
  return null;
}
