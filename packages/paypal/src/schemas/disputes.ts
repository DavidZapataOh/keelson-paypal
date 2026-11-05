import { z } from "zod";

const money = z.looseObject({ currency_code: z.string(), value: z.string() });

const link = z.looseObject({ href: z.string(), rel: z.string(), method: z.string().optional() });

const disputedTransaction = z.looseObject({
  buyer_transaction_id: z.string().optional(),
  seller_transaction_id: z.string().optional(),
  invoice_number: z.string().optional(),
  custom: z.string().optional(),
  gross_amount: money.optional(),
});

export const dispute = z.looseObject({
  dispute_id: z.string(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  status: z.string(),
  reason: z.string().optional(),
  dispute_life_cycle_stage: z.string().optional(),
  dispute_amount: money.optional(),
  disputed_transactions: z.array(disputedTransaction).optional(),
  links: z.array(link).optional(),
});
export type Dispute = z.infer<typeof dispute>;

export const disputeSearch = z.looseObject({
  items: z.array(z.looseObject({ dispute_id: z.string(), status: z.string() })).optional(),
  links: z.array(link).optional(),
});
export type DisputeSearch = z.infer<typeof disputeSearch>;

export const subsequentAction = z.looseObject({ links: z.array(link).optional() });
export type SubsequentAction = z.infer<typeof subsequentAction>;
