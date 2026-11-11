import type { AlibiBundle } from "@keelson/alibi";
import type { Dispute } from "@keelson/paypal";
import { describe, expect, test } from "vitest";
import { copy, fixtures } from "../../../packages/alibi/test/fixtures.ts";
import {
  cardDisputeFacts,
  disputeFacts,
  type FactsInput,
  type PayPalReads,
} from "../src/disputes/facts.ts";

const [fixture] = fixtures;
if (!fixture) throw new Error("no Alibi fixture");
const bundle = fixture.bundle;
const invoice = bundle.paypal?.invoice_id as string;
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
  trackers: [],
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
              },
            ],
          },
          trackers: [{ status: "SHIPPED" }, { status: "DELIVERED" }],
        }),
      }),
    ).facts;
    expect(twice.duplicate_capture).toBe(true);
    expect(twice.tracking_delivered).toBe(true);
  });

  test("delivery is read from the Add Tracking API, not the order's shipped trackers", () => {
    const shipped = disputeFacts(input({ reads: reads({ trackers: [{ status: "SHIPPED" }] }) }));
    expect(shipped.facts.tracking_delivered).toBe(false);
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

describe("cardDisputeFacts", () => {
  const countersigned = BigInt(bundle.tee.countersign.amount);
  const card = (approved: number) => ({
    ...copy(bundle),
    card: {
      issuer: "lithic",
      card_token: "card",
      last_four: "4242",
      ref_salt: `0x${"00".repeat(32)}`,
      controls: {},
      authorizations: Array.from({ length: approved }, (_, i) => ({
        id: `a${i}`,
        amount_minor: countersigned.toString(),
        currency: "USD",
        mcc: "5814",
        merchant_name: "BLUE HARBOR COFFEE",
        merchant_country: "US",
        network_id: "HSC000000000117",
        approved: true,
        verdicts: [],
      })),
    },
  });

  test("a chargeback is judged under the dispute reason it stands for", () => {
    for (const [reason, want] of [
      ["not_received", "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"],
      ["not_as_described", "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"],
      ["unauthorized", "UNAUTHORISED"],
    ] as const) {
      const { facts } = cardDisputeFacts({
        chargeback: { reason, recoveredMinor: 0n },
        settledMinor: countersigned,
        bundle: card(1),
        verified: true,
        sameCartCountersigned: false,
      });
      expect(facts.reason).toBe(want);
      expect(facts.tracking_delivered).toBe(false);
      expect(facts.duplicate_capture).toBe(false);
      expect(facts.captured_eq_countersigned).toBe(true);
      expect(facts.refund_recorded).toBe(false);
    }
    expect(() =>
      cardDisputeFacts({
        chargeback: { reason: "other", recoveredMinor: null },
        settledMinor: countersigned,
        bundle: card(1),
        verified: true,
        sameCartCountersigned: false,
      }),
    ).toThrow();
  });

  test("what the chargeback returned is the refund on record, and the settlement is compared", () => {
    const { facts } = cardDisputeFacts({
      chargeback: { reason: "not_received", recoveredMinor: 100n },
      settledMinor: countersigned + 1n,
      bundle: card(2),
      verified: false,
      sameCartCountersigned: true,
    });
    expect(facts).toMatchObject({
      proof_valid: false,
      refund_recorded: true,
      captured_eq_countersigned: false,
      duplicate_capture: true,
      duplicate_countersig: true,
    });
  });
});
