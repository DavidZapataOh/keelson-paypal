import { z } from "zod";

const currency = z.looseObject({ currency: z.string(), value: z.string() });

const senderBatchHeader = z.looseObject({ sender_batch_id: z.string().optional() });

export const createPayoutResponse = z.looseObject({
  batch_header: z.looseObject({
    payout_batch_id: z.string(),
    batch_status: z.string(),
    sender_batch_header: senderBatchHeader,
  }),
});
export type CreatePayoutResponse = z.infer<typeof createPayoutResponse>;

export const payoutBatch = z.looseObject({
  batch_header: z.looseObject({
    payout_batch_id: z.string(),
    batch_status: z.enum(["DENIED", "PENDING", "PROCESSING", "SUCCESS", "CANCELED"]),
    sender_batch_header: senderBatchHeader,
    amount: currency.optional(),
  }),
  items: z
    .array(
      z.looseObject({
        payout_item_id: z.string(),
        payout_batch_id: z.string(),
        transaction_id: z.string().optional(),
        transaction_status: z
          .enum([
            "SUCCESS",
            "FAILED",
            "PENDING",
            "UNCLAIMED",
            "RETURNED",
            "ONHOLD",
            "BLOCKED",
            "REFUNDED",
            "REVERSED",
          ])
          .optional(),
        payout_item: z.looseObject({
          amount: currency,
          receiver: z.string(),
          sender_item_id: z.string().optional(),
        }),
      }),
    )
    .optional(),
});
export type PayoutBatch = z.infer<typeof payoutBatch>;
