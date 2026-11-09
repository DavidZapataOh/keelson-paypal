import { alibiDigest, DST, hashObject, newId, toHex } from "@keelson/core";
import { type ApiResponse, ShipmentCarrier } from "@paypal/paypal-server-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { paypalConfig } from "../../src/config.ts";
import { fromSdkError } from "../../src/errors.ts";
import { holdOrderRequest } from "../../src/hold.ts";
import {
  encodeInvoiceId,
  encodeVerdictRef,
  operationRequestId,
  requestIdFromDigest,
} from "../../src/ids.ts";
import { createPayout, getPayoutBatch } from "../../src/payouts.ts";
import { verdictRefund } from "../../src/refunds.ts";
import { createPayPal, type PayPal } from "../../src/sdk.ts";
import { approveOrder, CANCEL_URL, payerActionUrl, RETURN_URL } from "../../src/testing.ts";
import { TokenCache } from "../../src/token.ts";
import { listTrackers, markDelivered } from "../../src/tracking.ts";
import { usd } from "./approve.ts";

let paypal: PayPal;

beforeAll(() => {
  const cfg = paypalConfig();
  paypal = createPayPal(cfg, new TokenCache(cfg));
});

async function timed<T>(label: string, p: Promise<T>): Promise<T> {
  const started = performance.now();
  const out = await p;
  console.info(`${label}: ${Math.round(performance.now() - started)} ms`);
  return out;
}

const sdk = <T>(label: string, p: Promise<ApiResponse<T>>) =>
  timed(
    label,
    p.then(
      (r) => r.result,
      (e) => Promise.reject(fromSdkError(e)),
    ),
  );

const PURCHASE = 300n;
const money = (minor: bigint) => ({ currency: "USD", minor }) as const;

describe("settlement (sandbox)", () => {
  it("tracks a delivery, refunds under a verdict and pays out under its reference", async () => {
    const mid = newId();
    const mandateHash = hashObject(DST.mandate, { mandate_id: mid });
    const { paypalRequestId, body } = holdOrderRequest({
      env: "s",
      mid,
      mandateHash,
      amount: money(PURCHASE),
      returnUrl: RETURN_URL,
      cancelUrl: CANCEL_URL,
    });
    const order = await sdk("create order", paypal.orders.createOrder({ paypalRequestId, body }));
    const orderId = order.id as string;
    await approveOrder(payerActionUrl(order));
    const authorized = await sdk(
      "authorize",
      paypal.orders.authorizeOrder({
        id: orderId,
        paypalRequestId: operationRequestId(orderId, "authorize"),
      }),
    );
    const authorizationId = authorized.purchaseUnits?.[0]?.payments?.authorizations?.[0]
      ?.id as string;
    const alibi = newId();
    const digest = alibiDigest({
      mandateHash: toHex(mandateHash),
      cartHash: toHex(hashObject(DST.alibi, { cart: alibi })),
      policySetHash: toHex(hashObject(DST.alibi, { policy: alibi })),
      countersignDigest: toHex(hashObject(DST.alibi, { countersign: alibi })),
      merchantId: "A4WCRYD5EYDF2",
      amount: money(PURCHASE),
      paypalOrderId: orderId,
    });
    const capture = await sdk(
      "capture",
      paypal.payments.captureAuthorizedPayment({
        authorizationId,
        paypalRequestId: requestIdFromDigest(digest),
        body: {
          amount: usd(PURCHASE),
          invoiceId: encodeInvoiceId(alibi, 1, digest),
          finalCapture: true,
        },
      }),
    );
    const captureId = capture.id as string;
    console.info(`order ${orderId}, capture ${captureId}`);

    // Delivery proof: Orders v2 tracker, then the Add Tracking API's delivered status.
    const trackingNumber = `9400${Date.now()}`;
    const tracked = await sdk(
      "add tracking",
      paypal.orders.createOrderTracking({
        id: orderId,
        body: { captureId, trackingNumber, carrier: ShipmentCarrier.Usps, notifyPayer: false },
      }),
    );
    expect(tracked.purchaseUnits?.[0]?.shipping?.trackers?.[0]?.status).toBe("SHIPPED");
    await timed(
      "mark delivered",
      markDelivered(paypal.fetch, { captureId, trackingNumber, carrier: "USPS" }),
    );
    const trackers = await timed("list trackers", listTrackers(paypal.fetch, captureId));
    expect(trackers.map((t) => [t.tracking_number, t.status])).toEqual([
      [trackingNumber, "DELIVERED"],
    ]);

    // The buyer's money back under the verdict's reference; a retry is the same refund.
    const verdictId = newId();
    const verdictDigest = hashObject(DST.verdict, { verdict_id: verdictId });
    const r = verdictRefund(verdictId, verdictDigest, "Refunded under a Keelson verdict.");
    const refund = await sdk("refund", paypal.payments.refundCapturedPayment({ captureId, ...r }));
    const again = await sdk(
      "refund replay",
      paypal.payments.refundCapturedPayment({ captureId, ...r }),
    );
    expect(again.id).toBe(refund.id);
    const read = await sdk(
      "get refund",
      paypal.payments.getRefund({ refundId: refund.id as string }),
    );
    expect(read.customId).toBe(encodeVerdictRef(verdictId, verdictDigest));
    expect(read.amount?.value).toBe("3.00");

    // The merchant's PayPal rail: a payout under the same reference.
    const receiver = process.env.PAYPAL_SANDBOX_PERSONAL_EMAIL;
    if (!receiver) throw new Error("PAYPAL_SANDBOX_PERSONAL_EMAIL is required");
    const ref = encodeVerdictRef(verdictId, verdictDigest);
    const started = performance.now();
    const created = await createPayout(paypal.fetch, {
      senderBatchId: `ks-${ref}`,
      items: [{ amount: money(100n), receiver, senderItemId: ref }],
    });
    const batchId = created.batch_header.payout_batch_id;
    let batch = await getPayoutBatch(paypal.fetch, batchId);
    while (batch.batch_header.batch_status !== "SUCCESS" && performance.now() - started < 90_000) {
      expect(["DENIED", "CANCELED"]).not.toContain(batch.batch_header.batch_status);
      await new Promise((res) => setTimeout(res, 2_000));
      batch = await getPayoutBatch(paypal.fetch, batchId);
    }
    console.info(`payout ${batchId}: ${Math.round(performance.now() - started)} ms to SUCCESS`);
    expect(batch.items?.[0]?.payout_item.sender_item_id).toBe(ref);
    expect(batch.items?.[0]?.transaction_status).toBe("SUCCESS");
  }, 240_000);
});
