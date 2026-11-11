import type Anthropic from "@anthropic-ai/sdk";
import { renderAlibiPdf } from "@keelson/alibi/pdf";
import { and, type Db, disputeResponses, disputes, eq, purchases, verdicts } from "@keelson/db";
import { acceptClaim, getDispute, provideEvidence, sendMessage } from "@keelson/paypal";
import type { Logger } from "pino";
import { ulid } from "ulid";
import { loadAlibi, publicCopy } from "../alibi/issue.ts";
import { call, type PayPalDeps } from "../paypal.ts";
import { type Draft, draftResponse } from "./drafter.ts";
import {
  ALIBI_FILE,
  nextStep,
  type OrderRead,
  responsePlan,
  type Step,
  trackerIds,
} from "./evidence.ts";

export interface RespondDeps {
  db: Db;
  log: Logger;
  paypal: PayPalDeps;
  /** Drafts the statement; without it the rule's fixed statement is sent. */
  anthropic?: Anthropic | undefined;
}

export type Response =
  | { status: "sent"; disputeId: string; action: Step; drafted: Draft["source"] | null }
  | { status: "already_sent"; disputeId: string; action: Step }
  | { status: "refunded"; disputeId: string; refundId: string }
  | { status: "unsettled"; disputeId: string; failure: string }
  | { status: "waiting" | "resolved" | "unattributed"; disputeId: string };

/** Rules whose evidence cites the order's own records. */
const READS_ORDER = new Set([10, 20]);

/**
 * Answers PayPal for the party the stored verdict names, once per action, lifecycle stage and
 * request from PayPal (its response due date):
 * the Alibi and a cited statement when the user or the merchant is at fault, the claim accepted
 * when the operator or Keelson is. With no call PayPal offers yet, it waits for the dispute to
 * move. A PayPal error throws, so the run is retried.
 */
export async function respondToDispute(deps: RespondDeps, disputeId: string): Promise<Response> {
  const { db } = deps;
  const [row] = await db
    .select({
      ruleId: verdicts.ruleId,
      liable: verdicts.liable,
      digest: verdicts.digest,
      facts: verdicts.facts,
      refundId: verdicts.refundId,
      outcome: verdicts.outcome,
      failure: verdicts.failure,
      purchaseId: disputes.purchaseId,
      orderId: purchases.paypalOrderId,
    })
    .from(verdicts)
    .innerJoin(disputes, eq(disputes.id, verdicts.disputeId))
    .innerJoin(purchases, eq(purchases.id, disputes.purchaseId))
    .where(eq(verdicts.disputeId, disputeId));
  if (!row) return { status: "unattributed", disputeId };

  const { fetch } = deps.paypal.paypal;
  const dispute = await getDispute(fetch, disputeId);
  if (dispute.status === "RESOLVED") return { status: "resolved", disputeId };
  const order: OrderRead =
    READS_ORDER.has(row.ruleId) && row.orderId
      ? await call(deps.paypal.paypal.orders.getOrder({ id: row.orderId }))
      : {};
  const plan = responsePlan(row, order);
  const step = nextStep(plan, dispute.links ?? []);
  if (!step) return { status: "waiting", disputeId };
  // The settlement refunded the buyer under the verdict: accepting the claim would refund twice.
  if (step === "accept_claim" && row.refundId) {
    return { status: "refunded", disputeId, refundId: row.refundId };
  }
  // Neither the chain nor Keelson's treasury has paid the merchant for the party at fault:
  // accepting would make the merchant refund the buyer out of its own pocket. PayPal decides instead.
  if (step === "accept_claim" && row.outcome === "failed") {
    return { status: "unsettled", disputeId, failure: row.failure ?? "unknown" };
  }
  const stage = dispute.dispute_life_cycle_stage ?? "UNKNOWN";
  const dueDate = dispute.seller_response_due_date ?? "";
  const [sent] = await db
    .select({ id: disputeResponses.id })
    .from(disputeResponses)
    .where(
      and(
        eq(disputeResponses.disputeId, disputeId),
        eq(disputeResponses.action, step),
        eq(disputeResponses.stage, stage),
        eq(disputeResponses.dueDate, dueDate),
      ),
    );
  if (sent) return { status: "already_sent", disputeId, action: step };

  const rule = `R${String(row.ruleId).padStart(2, "0")}`;
  const digest = `0x${Buffer.from(row.digest).toString("hex")}`;
  let input: unknown;
  let draft: Draft | null = null;
  if (step === "accept_claim") {
    input = { note: `${plan.finding} Attribution ${rule}, verdict ${digest}.` };
    await acceptClaim(fetch, disputeId, input as { note: string });
  } else {
    if (plan.action !== "contest") throw new Error("unreachable");
    const bundle = await loadAlibi(db, row.purchaseId);
    if (!bundle) throw new Error(`purchase ${row.purchaseId} has no alibi`);
    // PayPal and the drafting model get the Alibi without the user's login id and risk data.
    const pdf = await renderAlibiPdf(publicCopy(bundle));
    const amount = dispute.dispute_amount;
    const drafted = await draftResponse(deps.anthropic, {
      plan,
      step,
      dispute: {
        id: disputeId,
        reason: dispute.reason ?? "UNKNOWN",
        amount: amount ? `${amount.value} ${amount.currency_code}` : undefined,
      },
      verdict: { rule, digest, facts: row.facts as Record<string, unknown> },
      alibiPdf: pdf,
      trackers: trackerIds(order),
    });
    draft = drafted;
    const file = { name: ALIBI_FILE, bytes: pdf };
    if (step === "provide_evidence") {
      const evidences = plan.evidences.map((e) => {
        const notes = drafted.notes[e.evidence_type];
        return notes ? { ...e, notes } : e;
      });
      input = { evidences };
      const attached = evidences.some((e) => e.documents?.some((d) => d.name === ALIBI_FILE));
      await provideEvidence(fetch, disputeId, { evidences }, attached ? [file] : []);
    } else {
      const message = drafted.notes.message ?? plan.finding;
      input = { message };
      await sendMessage(fetch, disputeId, message, file);
    }
  }
  await db
    .insert(disputeResponses)
    .values({
      id: ulid(),
      disputeId,
      action: step,
      stage,
      dueDate,
      input,
      draft: draft && {
        source: draft.source,
        failure: draft.failure ?? null,
        statement: draft.statement,
        citations: draft.citations,
        usage: draft.usage,
      },
    })
    .onConflictDoNothing();
  deps.log.info(
    { disputeId, action: step, stage, rule, drafted: draft?.source, failure: draft?.failure },
    "dispute answered",
  );
  return { status: "sent", disputeId, action: step, drafted: draft?.source ?? null };
}
