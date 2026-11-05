import { type Money, toPayPalValue } from "@keelson/core";
import type { PayPalFetch } from "./rest.js";
import { createPayoutResponse, type PayoutBatch, payoutBatch } from "./schemas/payouts.js";

export interface PayoutItem {
  amount: Money;
  receiver: string;
  senderItemId: string;
  note?: string;
}

/** `senderBatchId` doubles as the idempotency key: PayPal rejects a reused one. */
export async function createPayout(
  f: PayPalFetch,
  input: { senderBatchId: string; items: PayoutItem[] },
) {
  const res = await f<unknown>("POST", "/v1/payments/payouts", {
    requestId: input.senderBatchId,
    body: {
      sender_batch_header: { sender_batch_id: input.senderBatchId, recipient_type: "EMAIL" },
      items: input.items.map((i) => ({
        recipient_type: "EMAIL",
        receiver: i.receiver,
        sender_item_id: i.senderItemId,
        amount: { currency: i.amount.currency, value: toPayPalValue(i.amount) },
        ...(i.note ? { note: i.note } : {}),
      })),
    },
  });
  return createPayoutResponse.parse(res);
}

export async function getPayoutBatch(f: PayPalFetch, batchId: string): Promise<PayoutBatch> {
  return payoutBatch.parse(
    await f<unknown>("GET", `/v1/payments/payouts/${encodeURIComponent(batchId)}`),
  );
}
