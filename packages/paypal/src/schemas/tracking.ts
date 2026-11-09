import { z } from "zod";

const shippingTracker = z.looseObject({
  transaction_id: z.string(),
  tracking_number: z.string().optional(),
  status: z.string(),
  carrier: z.string().optional(),
});
export type ShippingTracker = z.infer<typeof shippingTracker>;

export const trackerList = z.looseObject({ trackers: z.array(shippingTracker).default([]) });
