import type { AlibiBundle } from "@keelson/alibi";
import { type CurrencyCode, fromPayPalValue } from "@keelson/core";
import type { Dispute } from "@keelson/paypal";

/** The `dispute_reason` values of the PayPal Disputes v1 API. */
const REASONS = new Set([
  "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
  "UNAUTHORISED",
  "CREDIT_NOT_PROCESSED",
  "DUPLICATE_TRANSACTION",
  "INCORRECT_AMOUNT",
  "PAYMENT_BY_OTHER_MEANS",
  "CANCELED_RECURRING_BILLING",
  "PROBLEM_WITH_REMITTANCE",
  "OTHER",
]);

/** The `failedFieldsMask` bit of each policy `@id`, as the engine sets them. */
const FIELD_BITS: Readonly<Record<string, number>> = {
  agent: 0,
  sanity: 1,
  currency: 2,
  amount: 3,
  budget: 4,
  merchant: 5,
  window: 6,
  quantity: 7,
  category: 8,
  variant: 9,
  returns: 10,
  returns_free: 11,
};

/** The policy each Channel3 comparison observes independently of the agent. */
const OBSERVED_BY: Readonly<Record<string, string>> = { price: "amount", variant: "variant" };

type Color = "green" | "amber" | "gray";

/** The context the attribution policy sets judge a dispute on. */
interface Facts {
  reason: string;
  proof_valid: boolean;
  failed_green: boolean;
  failed_amber: boolean;
  failed_gray: boolean;
  captured_eq_countersigned: boolean;
  duplicate_countersig: boolean;
  duplicate_capture: boolean;
  tracking_delivered: boolean;
  snapshot_matches_item: boolean;
  refund_recorded: boolean;
}

/** One mandate field of the countersigned evaluation, as the dispute sees it now. */
interface FieldResult {
  id: string;
  field: string;
  color: Color;
  /** Its `failedFieldsMask` bit. */
  bit: number;
  /** The countersigned evaluation passed it. */
  pass: boolean;
  /** An independent observation of the item contradicts what the agent saw. */
  contradicted: boolean;
}

interface Money {
  currencyCode?: string | undefined;
  value?: string | undefined;
}

/**
 * The PayPal reads a dispute is judged on, all made after the dispute was opened.
 *
 * @internal
 */
export interface PayPalReads {
  dispute: Dispute;
  capture: { status?: string | undefined; amount?: Money | undefined };
  order: {
    purchaseUnits?:
      | {
          payments?: { captures?: { status?: string; invoiceId?: string }[] | undefined };
          shipping?: { trackers?: { status?: string }[] | undefined };
        }[]
      | undefined;
  };
}

export interface FactsInput {
  reads: PayPalReads;
  bundle: AlibiBundle;
  /** The Alibi verified against the chain, its anchor included. */
  verified: boolean;
  /** Another captured purchase of the same mandate carries the same countersigned cart. */
  sameCartCountersigned: boolean;
}

export interface DisputeFacts {
  facts: Facts;
  fields: FieldResult[];
  /** A failed field of each color, by its bit: the verdict names the one of its rule's color. */
  failedFields: Partial<Record<Color, number>>;
}

const minorOf = (m: Money | undefined): bigint | undefined =>
  m?.currencyCode && m.value
    ? fromPayPalValue(m.currencyCode as CurrencyCode, m.value).minor
    : undefined;

/**
 * The facts of a dispute, from the PayPal reads and the purchase's Alibi. Every mandate field of
 * the countersigned evaluation is judged on its own: it failed if the evaluation failed it or if
 * the Channel3 observation in the Alibi contradicts it.
 */
export function disputeFacts({
  reads,
  bundle,
  verified,
  sameCartCountersigned,
}: FactsInput): DisputeFacts {
  const reason = reads.dispute.reason;
  if (!reason || !REASONS.has(reason)) throw new Error(`unknown dispute reason ${reason}`);

  const mismatches = new Set(
    (
      (bundle.channel3_observation as { comparison?: { mismatches?: string[] } } | undefined)
        ?.comparison?.mismatches ?? []
    ).flatMap((m) => OBSERVED_BY[m] ?? []),
  );
  const fields = (
    bundle.eval.fields as { id: string; field: string; color: Color; pass: boolean }[]
  )
    .filter((f) => f.id in FIELD_BITS)
    .map(
      (f): FieldResult => ({
        id: f.id,
        field: f.field,
        color: f.color,
        bit: FIELD_BITS[f.id] as number,
        pass: f.pass,
        contradicted: mismatches.has(f.id),
      }),
    );
  const failedFields: Partial<Record<Color, number>> = {};
  for (const f of fields) {
    if ((!f.pass || f.contradicted) && failedFields[f.color] === undefined) {
      failedFields[f.color] = f.bit;
    }
  }

  const countersigned = BigInt(bundle.tee.countersign.amount);
  const invoice = bundle.paypal.invoice_id;
  const captures = (reads.order.purchaseUnits ?? []).flatMap((u) => u.payments?.captures ?? []);
  const live = (c: { status?: string }) => c.status !== "DECLINED" && c.status !== "FAILED";
  const trackers = (reads.order.purchaseUnits ?? []).flatMap((u) => u.shipping?.trackers ?? []);

  return {
    facts: {
      reason,
      proof_valid: verified,
      failed_green: failedFields.green !== undefined,
      failed_amber: failedFields.amber !== undefined,
      failed_gray: failedFields.gray !== undefined,
      captured_eq_countersigned: minorOf(reads.capture.amount) === countersigned,
      duplicate_countersig: sameCartCountersigned,
      duplicate_capture:
        invoice !== undefined &&
        captures.filter((c) => c.invoiceId === invoice && live(c)).length > 1,
      tracking_delivered: trackers.some((t) => t.status === "DELIVERED"),
      snapshot_matches_item: !mismatches.has("variant"),
      refund_recorded:
        reads.capture.status === "REFUNDED" || reads.capture.status === "PARTIALLY_REFUNDED",
    },
    fields,
    failedFields,
  };
}
