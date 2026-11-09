import type { AlibiBundle } from "@keelson/alibi";
import type { Dispute } from "@keelson/paypal";
import { describe, expect, test } from "vitest";
import { copy, fixtures } from "../../../packages/alibi/test/fixtures.ts";
import { disputeFacts, type FactsInput, type PayPalReads } from "../src/disputes/facts.ts";

const [fixture] = fixtures;
if (!fixture) throw new Error("no Alibi fixture");
const bundle = fixture.bundle;
const invoice = bundle.paypal.invoice_id as string;
const total = (Number(bundle.tee.countersign.amount) / 100).toFixed(2);

const dispute = (reason: string): Dispute => ({
  dispute_id: "PP-D-27803",
  status: "WAITING_FOR_SELLER_RESPONSE",
  reason,
  disputed_transactions: [{ invoice_number: invoice }],
});

const reads = (over: Partial<PayPalReads> = {}): PayPalReads => ({
  dispute: dispute("UNAUTHORISED"),
  capture: { status: "COMPLETED", amount: { currencyCode: "USD", value: total } },
  order: {
    purchaseUnits: [{ payments: { captures: [{ status: "COMPLETED", invoiceId: invoice }] } }],
  },
  ...over,
});

const input = (over: Partial<FactsInput> = {}): FactsInput => ({
  reads: reads(),
  bundle,
  verified: true,
  sameCartCountersigned: false,
  ...over,
});

/** The bundle with the given trace fields failed, and the Channel3 mismatches. */
function edited(failed: string[], mismatches?: string[]): AlibiBundle {
  const b = copy(bundle);
  for (const f of b.eval.fields as { id: string; pass: boolean }[]) {
    if (failed.includes(f.id)) f.pass = false;
  }
  if (mismatches) b.channel3_observation = { comparison: { mismatches } };
  return b;
}

describe("disputeFacts", () => {
  test("a clean purchase under an unauthorised claim blames no field", () => {
    const { facts, fields, failedFields } = disputeFacts(input());
    expect(facts).toEqual({
      reason: "UNAUTHORISED",
      proof_valid: true,
      failed_green: false,
      failed_amber: false,
      failed_gray: false,
      captured_eq_countersigned: true,
      duplicate_countersig: false,
      duplicate_capture: false,
      tracking_delivered: false,
      snapshot_matches_item: true,
      refund_recorded: false,
    });
    expect(fields.length).toBe(bundle.eval.fields.length);
    expect(failedFields).toEqual({});
  });

  test("each failed field counts under its own color and bit", () => {
    const { facts, failedFields } = disputeFacts(input({ bundle: edited(["variant"]) }));
    expect(facts.failed_amber).toBe(true);
    expect(facts.failed_green).toBe(false);
    expect(failedFields).toEqual({ amber: 9 });
    const both = disputeFacts(input({ bundle: edited(["amount", "category"]) }));
    expect(both.failedFields).toEqual({ green: 3, amber: 8 });
  });

  test("a Channel3 mismatch fails the field it observes", () => {
    const { facts, fields, failedFields } = disputeFacts(
      input({ bundle: edited([], ["variant", "brand"]) }),
    );
    expect(fields.find((f) => f.id === "variant")?.contradicted).toBe(true);
    expect(failedFields).toEqual({ amber: 9 });
    expect(facts.snapshot_matches_item).toBe(false);
  });

  test("the PayPal reads decide the money facts", () => {
    const refunded = disputeFacts(
      input({
        reads: reads({
          capture: { status: "PARTIALLY_REFUNDED", amount: { currencyCode: "USD", value: "9.99" } },
        }),
      }),
    ).facts;
    expect(refunded.refund_recorded).toBe(true);
    expect(refunded.captured_eq_countersigned).toBe(false);

    const twice = disputeFacts(
      input({
        reads: reads({
          order: {
            purchaseUnits: [
              {
                payments: {
                  captures: [
                    { status: "COMPLETED", invoiceId: invoice },
                    { status: "COMPLETED", invoiceId: invoice },
                    { status: "DECLINED", invoiceId: invoice },
                  ],
                },
                shipping: { trackers: [{ status: "SHIPPED" }, { status: "DELIVERED" }] },
              },
            ],
          },
        }),
      }),
    ).facts;
    expect(twice.duplicate_capture).toBe(true);
    expect(twice.tracking_delivered).toBe(true);
  });

  test("the proof and duplicate countersign facts come from the caller's checks", () => {
    const f = disputeFacts(input({ verified: false, sameCartCountersigned: true })).facts;
    expect(f.proof_valid).toBe(false);
    expect(f.duplicate_countersig).toBe(true);
  });

  test("a reason PayPal does not define is refused", () => {
    expect(() => disputeFacts(input({ reads: reads({ dispute: dispute("FRAUD") }) }))).toThrow(
      /unknown dispute reason/,
    );
  });
});
